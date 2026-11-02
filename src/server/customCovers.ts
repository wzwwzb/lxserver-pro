import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { toSimplified } from './utils/zhConvert'
import {
    type LyricSong, type LyricJob, resolveLyricSong, localMusicInfoSkipReason,
    matchLocalMusicCandidates, normalizeMusicMatchText, cleanMusicMatchTitle, withLyricTimeout,
} from './customLyrics'

const MAX_COVER_BYTES = 8 * 1024 * 1024
const coverExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.JPG', '.JPEG', '.PNG', '.WEBP', '.GIF']
const within = (root: string, file: string) => {
    const relative = path.relative(root, file)
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Identify actual raster data, rather than trusting a URL suffix or HTTP header. */
export const inspectCoverImage = (data: Buffer) => {
    if (!Buffer.isBuffer(data) || data.length < 12 || data.length > MAX_COVER_BYTES) return null
    let mime = '', ext = '', width = 0, height = 0
    if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' &&
        data.toString('ascii', data.length - 8, data.length - 4) === 'IEND') {
        mime = 'image/png'; ext = '.png'; width = data.readUInt32BE(16); height = data.readUInt32BE(20)
    } else if (data[0] === 0xff && data[1] === 0xd8 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9) {
        let offset = 2
        while (offset + 4 <= data.length) {
            if (data[offset++] !== 0xff) break
            while (data[offset] === 0xff) offset++
            const marker = data[offset++]
            if (marker === 0xda || marker === 0xd9) break
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
            if (offset + 2 > data.length) break
            const length = data.readUInt16BE(offset)
            if (length < 2 || offset + length > data.length) break
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
                height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5)
                mime = 'image/jpeg'; ext = '.jpg'; break
            }
            offset += length
        }
    } else if (data.length >= 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) {
        const kind = data.toString('ascii', 12, 16)
        if (kind === 'VP8X') { width = data.readUIntLE(24, 3) + 1; height = data.readUIntLE(27, 3) + 1 }
        else if (kind === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) {
            width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff
        } else if (kind === 'VP8L' && data[20] === 0x2f) {
            const bits = data.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1
        }
        mime = 'image/webp'; ext = '.webp'
    } else if (['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) && data[data.length - 1] === 0x3b) {
        mime = 'image/gif'; ext = '.gif'; width = data.readUInt16LE(6); height = data.readUInt16LE(8)
    }
    return mime && width > 0 && height > 0 && width <= 15000 && height <= 15000 && width * height <= 100000000
        ? { mime, ext, width, height } : null
}

const coverPaths = (directory: string, filename: string) => {
    const resolved = resolveLyricSong(directory, filename)
    const base = resolved.lyricFile.slice(0, -4)
    return { file: resolved.file, files: coverExtensions.map(ext => base + ext), base }
}
const exists = (file: string) => {
    try { fs.lstatSync(file); return true } catch (error: any) {
        if (error.code === 'ENOENT') return false
        throw error
    }
}

/** The list only needs safe file metadata; image bytes are read when requested. */
export const findSidecarCover = (directory: string, filename: string) => {
    try {
        const root = fs.realpathSync(directory)
        for (const file of coverPaths(root, filename).files) {
            try {
                const real = fs.realpathSync(file)
                if (!within(root, real)) continue
                const stat = fs.statSync(real)
                if (stat.isFile() && stat.size > 0 && stat.size <= MAX_COVER_BYTES) {
                    return { file: real, filename: path.relative(root, file).replace(/\\/gu, '/'), mtime: stat.mtimeMs, size: stat.size }
                }
            } catch { /* Try the next supported extension. */ }
        }
    } catch { /* The audio or root may have disappeared. */ }
    return null
}

export const readSidecarCover = (directory: string, filename: string) => {
    try {
        const found = findSidecarCover(directory, filename)
        if (!found) return null
        const data = fs.readFileSync(found.file)
        const image = inspectCoverImage(data)
        return image ? { data, ...image } : null
    } catch { return null }
}

/** Only platform image CDNs may be contacted, including after redirects. */
export const allowedCoverUrl = (value: string) => {
    try {
        const url = new URL(value)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
            ['music.126.net', 'gtimg.cn', 'qpic.cn', 'imgcache.qq.com', 'kuwo.cn'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))
    } catch { return false }
}

export const downloadCoverImage = async (value: string, options: {
    timeoutMs?: number, maxBytes?: number, allowUrl?: (value: string) => boolean,
    getAgent?: (url: string) => Promise<any>,
} = {}): Promise<Buffer> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
    const maxBytes = Math.min(options.maxBytes ?? MAX_COVER_BYTES, MAX_COVER_BYTES)
    const visit = async (address: string, redirects: number): Promise<Buffer> => {
        if (!(options.allowUrl || allowedCoverUrl)(address)) throw new Error('unsupported_cover_host')
        const url = new URL(address)
        const agent = await options.getAgent?.(address)
        controller.signal.throwIfAborted()
        return new Promise((resolve, reject) => {
            const request = (url.protocol === 'https:' ? https : http).get(url, {
                agent, signal: controller.signal,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/jpeg,image/png,image/webp,image/gif' },
            }, response => {
                response.on('error', reject)
                response.on('aborted', () => reject(new Error('cover_response_interrupted')))
                const status = response.statusCode || 0
                if ([301, 302, 303, 307, 308].includes(status)) {
                    response.resume()
                    if (redirects >= 3 || !response.headers.location) { reject(new Error('cover_redirect_limit')); return }
                    let next: string
                    try { next = new URL(response.headers.location, url).href } catch (error) { reject(error); return }
                    void visit(next, redirects + 1).then(resolve, reject)
                    return
                }
                if (status < 200 || status >= 300 || Number(response.headers['content-length'] || 0) > maxBytes) {
                    response.destroy(); reject(new Error('cover_response_rejected')); return
                }
                const chunks: Buffer[] = []
                let size = 0
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length
                    if (size > maxBytes) { reject(new Error('cover_too_large')); response.destroy(); request.destroy(); return }
                    chunks.push(chunk)
                })
                response.on('end', () => {
                    const data = Buffer.concat(chunks)
                    const image = inspectCoverImage(data)
                    if (!image || image.width < 128 || image.height < 128) { reject(new Error('invalid_cover_image')); return }
                    resolve(data)
                })
            })
            request.on('error', reject)
        })
    }
    try { return await visit(value, 0) } finally { clearTimeout(timer) }
}

const albumName = (value: any) => {
    const text = String(value || '').trim()
    return !text || /^(?:unknown(?:\s*album)?|未知(?:专辑)?|未收录|无|none|null)$/iu.test(text) ? '' : normalizeMusicMatchText(text)
}

export const matchCoverCandidates = (local: LyricSong, candidates: any[]) => {
    const matches = matchLocalMusicCandidates(local, candidates, true)
    const album = albumName(local.album)
    if (album) return matches.filter(song => albumName(song.albumName || song.album) === album)
    // With no local album, different candidate albums cannot be distinguished reliably.
    const albums = new Set(matches.map(song => albumName(song.albumName || song.album)).filter(Boolean))
    return albums.size > 1 ? [] : matches.filter(song => !!albumName(song.albumName || song.album))
}

export interface CoverJob extends LyricJob {
    details: Array<LyricJob['details'][number] & { coverFilename?: string, album?: string }>
}
interface Dependencies {
    getRoot: (username: string) => string | null
    canWrite: (username: string) => boolean
    list: (username: string) => Promise<LyricSong[]>
    hasCover: (username: string, filename: string) => Promise<boolean> | boolean
    reportPath: (username: string) => string
    search: (source: string, query: string) => Promise<any[]>
    fetchCover: (source: string, song: any) => Promise<Buffer>
    onSaved: (username: string, filename: string, coverFilename: string) => void
    sources?: string[]
    timeoutMs?: number
    delayMs?: number
}

export const createCustomCoversManager = (deps: Dependencies) => {
    const jobs = new Map<string, CoverJob>()
    const cancelled = new Set<string>()
    const sources = deps.sources || ['wy', 'tx', 'kw']
    const timeout = deps.timeoutMs ?? 10000
    const persist = (username: string, job: CoverJob) => {
        const target = deps.reportPath(username)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target + '.tmp', JSON.stringify(job, null, 2), { mode: 0o600 })
        fs.renameSync(target + '.tmp', target)
    }
    const get = (username: string): CoverJob | null => {
        if (jobs.has(username)) return structuredClone(jobs.get(username)!)
        try {
            const job: CoverJob = JSON.parse(fs.readFileSync(deps.reportPath(username), 'utf8'))
            if (!job.id || !Array.isArray(job.details)) return null
            if (['running', 'cancelling'].includes(job.status)) {
                job.status = 'interrupted'; job.finishedAt = new Date().toISOString()
                job.message = '服务器重启中断了任务，可重新补全，已有封面会自动跳过'
                persist(username, job)
            }
            jobs.set(username, job)
            return structuredClone(job)
        } catch { return null }
    }
    const run = async (username: string, job: CoverJob, requested?: string[]) => {
        const configuredRoot = deps.getRoot(username)
        if (!configuredRoot) throw new Error('自定义音乐目录未启用')
        const root = fs.realpathSync(configuredRoot)
        const items = await deps.list(username)
        const byFile = new Map(items.map(item => [item.filename, item]))
        const filenames = requested || items.map(item => item.filename)
        const failures = new Map<string, number>()
        const cache = new Map<string, { data: Buffer, source: string, songmid: string, album: string }>()
        let cacheBytes = 0
        job.total = filenames.length
        persist(username, job)
        const complete = (song: LyricSong, status: 'downloaded' | 'skipped' | 'failed', reason: string,
            match: { source?: string, songmid?: string, album?: string, coverFilename?: string } = {}) => {
            job.details.push({ filename: song.filename, name: song.name, status, reason, ...match })
            job.processed++; job[status]++
            persist(username, job)
        }
        const rootUnchanged = () => deps.canWrite(username) && deps.getRoot(username) === configuredRoot && fs.realpathSync(configuredRoot) === root
        for (const filename of filenames) {
            if (cancelled.has(job.id)) break
            if (!rootUnchanged()) { job.message = '写入权限或音乐目录已改变，任务已停止'; cancelled.add(job.id); break }
            const song = byFile.get(filename) || { filename, name: path.basename(filename), singer: '' }
            job.current = song.name
            persist(username, job)
            try {
                const resolved = coverPaths(root, filename)
                if (resolved.files.some(exists)) { complete(song, 'skipped', '已有同名封面文件'); continue }
                if (await deps.hasCover(username, filename)) { complete(song, 'skipped', '已有内嵌封面'); continue }
                const skipReason = localMusicInfoSkipReason(song)
                if (skipReason) { complete(song, 'skipped', skipReason); continue }
                const original = fs.statSync(resolved.file)
                const query = `${cleanMusicMatchTitle(toSimplified(song.name))} ${toSimplified(song.singer)}`
                const key = [song.name, song.singer, song.interval, song.album].map(normalizeMusicMatchText).join('\0')
                let found = cache.get(key)
                let searched = false, hadMatch = false
                for (const source of sources) {
                    if (found || cancelled.has(job.id)) break
                    if ((failures.get(source + ':search') || 0) >= 3 || (failures.get(source + ':cover') || 0) >= 3) continue
                    let candidates: any[]
                    try {
                        candidates = matchCoverCandidates(song, await withLyricTimeout(deps.search(source, query), timeout) || [])
                        searched = true; failures.set(source + ':search', 0)
                    } catch { failures.set(source + ':search', (failures.get(source + ':search') || 0) + 1); continue }
                    for (const candidate of candidates.slice(0, 2)) {
                        if (cancelled.has(job.id)) break
                        hadMatch = true
                        try {
                            const data = await withLyricTimeout(deps.fetchCover(source, candidate), timeout)
                            const image = inspectCoverImage(data)
                            if (!image || image.width < 128 || image.height < 128) throw new Error('invalid_cover_image')
                            failures.set(source + ':cover', 0)
                            found = { data, source, songmid: String(candidate.songmid || candidate.id || ''), album: String(candidate.albumName || candidate.album || '') }
                            cache.set(key, found); cacheBytes += data.length
                            while (cacheBytes > 16 * 1024 * 1024 && cache.size > 0) {
                                const first = cache.keys().next().value!
                                cacheBytes -= cache.get(first)!.data.length; cache.delete(first)
                            }
                            break
                        } catch { failures.set(source + ':cover', (failures.get(source + ':cover') || 0) + 1) }
                    }
                }
                if (cancelled.has(job.id)) break
                if (!found) {
                    complete(song, 'skipped', hadMatch ? '封面不可用或图片无效，已跳过' :
                        !searched ? '搜索服务暂不可用，已跳过' : '没有歌名、歌手、版本、时长及专辑均可靠匹配的结果')
                    continue
                }
                if (!rootUnchanged()) { cancelled.add(job.id); break }
                const current = coverPaths(root, filename)
                const stat = fs.statSync(current.file)
                if (current.file !== resolved.file || stat.size !== original.size || stat.mtimeMs !== original.mtimeMs) {
                    complete(song, 'skipped', '匹配期间音频文件已改变'); continue
                }
                if (current.files.some(exists) || await deps.hasCover(username, filename)) { complete(song, 'skipped', '已有封面，保留原文件'); continue }
                if (cancelled.has(job.id) || !rootUnchanged()) { cancelled.add(job.id); break }
                const target = current.base + inspectCoverImage(found.data)!.ext
                let descriptor: number
                try { descriptor = fs.openSync(target, 'wx') } catch (error: any) {
                    if (error.code === 'EEXIST') { complete(song, 'skipped', '已有同名封面文件'); continue }
                    throw error
                }
                try { fs.writeFileSync(descriptor, found.data) } catch (error) {
                    try { fs.unlinkSync(target) } catch { }
                    throw error
                } finally { fs.closeSync(descriptor) }
                const coverFilename = path.relative(root, target).replace(/\\/gu, '/')
                deps.onSaved(username, filename, coverFilename)
                complete(song, 'downloaded', '已保存同名外置封面', { source: found.source, songmid: found.songmid, album: found.album, coverFilename })
            } catch { complete(song, 'failed', '文件不可访问、路径无效或封面写入失败') } finally {
                const delay = deps.delayMs ?? 120
                if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
        job.status = cancelled.has(job.id) ? 'cancelled' : 'completed'
        job.current = ''; job.finishedAt = new Date().toISOString()
        cancelled.delete(job.id); persist(username, job)
    }
    return {
        get,
        start(username: string, filenames?: string[]) {
            if (!deps.canWrite(username)) throw new Error('管理员未允许写入自定义目录')
            if (!deps.getRoot(username)) throw new Error('自定义音乐目录未启用')
            if (filenames !== undefined && (!Array.isArray(filenames) || filenames.length > 10000 || filenames.some(name => typeof name !== 'string' || name.length > 4096))) throw new Error('无效的歌曲列表')
            const previous = get(username)
            if (previous && ['running', 'cancelling'].includes(previous.status)) return previous
            const job: CoverJob = { id: crypto.randomUUID(), status: 'running', total: 0, processed: 0, downloaded: 0, skipped: 0, failed: 0,
                current: '', startedAt: new Date().toISOString(), details: [] }
            jobs.set(username, job); persist(username, job)
            void run(username, job, filenames ? [...new Set(filenames)] : undefined).catch(() => {
                job.status = 'failed'; job.current = ''; job.finishedAt = new Date().toISOString()
                job.message = '任务无法继续，请检查音乐目录及服务器存储权限'
                try { persist(username, job) } catch { /* Keep the failure visible in memory. */ }
            })
            return structuredClone(job)
        },
        cancel(username: string, id: string) {
            const job = jobs.get(username)
            if (!job || job.id !== id || !['running', 'cancelling'].includes(job.status)) return false
            cancelled.add(id); job.status = 'cancelling'; persist(username, job)
            return true
        },
    }
}
