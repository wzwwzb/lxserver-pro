import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

const inFlight = new Map<string, Promise<string>>()
let activeCount = 0
const waiting: Array<() => void> = []
const acquireSlot = (): Promise<void> => {
    if (activeCount < 2) { activeCount++; return Promise.resolve() }
    return new Promise(resolve => waiting.push(resolve))
}
const releaseSlot = () => {
    const next = waiting.shift()
    if (next) next()
    else activeCount--
}
const signatures = [Buffer.from('ff1f00e8', 'hex'), Buffer.from('1fffe800', 'hex'),
    Buffer.from('7ffe8001', 'hex'), Buffer.from('fe7f0180', 'hex')]

/** DTS-CD often advertises PCM in RIFF; never feed its compressed frames to a PCM decoder. */
export async function isDtsWave(file: string): Promise<boolean> {
    const fd = await fs.promises.open(file, 'r')
    try {
        const header = Buffer.alloc(12)
        await fd.read(header, 0, 12, 0)
        if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WAVE') return false
        const size = (await fd.stat()).size
        let offset = 12
        for (let count = 0; count < 256 && offset + 8 <= size; count++) {
            const chunk = Buffer.alloc(8)
            await fd.read(chunk, 0, 8, offset)
            const length = chunk.readUInt32LE(4)
            if (chunk.toString('ascii', 0, 4) === 'data') {
                const data = Buffer.alloc(Math.min(length, 65536))
                const { bytesRead } = await fd.read(data, 0, data.length, offset + 8)
                return signatures.some(signature => {
                    const first = data.subarray(0, bytesRead).indexOf(signature)
                    if (first < 0) return false
                    const second = data.indexOf(signature, first + 4)
                    return second >= 0 && data.indexOf(signature, second + 4) >= 0
                })
            }
            offset += 8 + length + (length % 2)
        }
        return false
    } finally { await fd.close() }
}

const decode = async (file: string, destination: string): Promise<string> => {
    const temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.part`
    try {
        await new Promise<void>((resolve, reject) => {
            const proc = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-threads', '2', '-i', file,
                '-map', '0:a:0', '-vn', '-ac', '2', '-c:a', 'flac', '-threads', '2', '-f', 'flac', '-y', temporary],
            { stdio: ['ignore', 'ignore', 'pipe'] })
            const timeout = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('Audio conversion timed out')) }, 90000)
            // Drain stderr without exposing private filesystem paths to clients.
            proc.stderr.resume()
            proc.once('error', () => { clearTimeout(timeout); reject(new Error('FFmpeg is required for DTS-WAV playback')) })
            proc.once('close', code => {
                clearTimeout(timeout)
                if (code === 0) resolve()
                else reject(new Error('Unable to decode DTS-WAV audio'))
            })
        })
        await fs.promises.chmod(temporary, 0o600)
        await fs.promises.rename(temporary, destination)
        return destination
    } finally { await fs.promises.rm(temporary, { force: true }) }
}

/** Original files and downloads stay untouched; cached FLAC supports ordinary HTTP ranges. */
export async function compatibleLocalAudio(file: string, cacheRoot: string): Promise<string> {
    if (path.extname(file).toLowerCase() !== '.wav' || !await isDtsWave(file)) return file
    const info = await fs.promises.stat(file)
    const key = crypto.createHash('sha256').update(`${file}\0${info.size}\0${info.mtimeMs}`).digest('hex')
    const destination = path.join(cacheRoot, `${key}.flac`)
    try { if ((await fs.promises.stat(destination)).size > 0) return destination } catch { /* cache miss */ }
    const pending = inFlight.get(key)
    if (pending) return pending
    const task = (async () => {
        await acquireSlot()
        try {
            await fs.promises.mkdir(cacheRoot, { recursive: true, mode: 0o700 })
            const result = await decode(file, destination)
            const latest = await fs.promises.stat(file)
            if (latest.size !== info.size || latest.mtimeMs !== info.mtimeMs) {
                await fs.promises.rm(result, { force: true })
                throw new Error('Audio source changed during conversion; retry')
            }
            return result
        } finally { releaseSlot() }
    })()
    inFlight.set(key, task)
    try { return await task } finally { inFlight.delete(key) }
}
