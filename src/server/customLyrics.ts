import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { toSimplified } from './utils/zhConvert'

export interface LyricSong {
    filename: string
    name: string
    singer: string
    album?: string
    interval?: string | number
    hasEmbedLyric?: boolean
}

export interface LyricJob {
    id: string
    status: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
    total: number
    processed: number
    downloaded: number
    skipped: number
    failed: number
    current: string
    startedAt: string
    finishedAt?: string
    message?: string
    details: Array<{ filename: string, name: string, status: 'downloaded' | 'skipped' | 'failed', reason: string, source?: string, songmid?: string }>
}

interface Dependencies {
    getRoot: (username: string) => string | null
    canWrite: (username: string) => boolean
    list: (username: string) => Promise<LyricSong[]>
    reportPath: (username: string) => string
    search: (source: string, query: string) => Promise<any[]>
    fetchLyrics: (source: string, song: any) => Promise<any>
    onSaved: (username: string, filename: string, lyricFilename: string) => void
    sources?: string[]
    timeoutMs?: number
    delayMs?: number
}

const audioExtension = /\.(mp3|flac|m4a|ogg|wav|ape)$/iu
const within = (root: string, file: string) => {
    const relative = path.relative(root, file)
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** Resolve both the audio and its parent after asynchronous network operations. */
export const resolveLyricSong = (directory: string, filename: string) => {
    if (!filename || filename.includes('\0') || path.isAbsolute(filename) || !audioExtension.test(filename)) throw new Error('unsafe_path')
    const root = fs.realpathSync(directory)
    const original = path.resolve(root, filename)
    if (!within(root, original)) throw new Error('unsafe_path')
    const file = fs.realpathSync(original)
    if (!within(root, file) || !fs.statSync(file).isFile()) throw new Error('unsafe_path')
    const parent = fs.realpathSync(path.dirname(original))
    if (parent !== root && !within(root, parent)) throw new Error('unsafe_path')
    return { file, lyricFile: path.join(parent, path.basename(original, path.extname(original)) + '.lrc') }
}

const exists = (file: string) => {
    try { fs.lstatSync(file); return true } catch (error: any) {
        if (error.code === 'ENOENT') return false
        throw error
    }
}

export const readSidecarLyrics = (directory: string, filename: string): string => {
    try {
        const { lyricFile } = resolveLyricSong(directory, filename)
        const root = fs.realpathSync(directory)
        const realLyric = fs.realpathSync(lyricFile)
        if (!within(root, realLyric) || !fs.statSync(realLyric).isFile() || fs.statSync(realLyric).size > 1024 * 1024) return ''
        return fs.readFileSync(realLyric, 'utf8')
    } catch { return '' }
}

const normalize = (text: any) => toSimplified(String(text || '').normalize('NFKC')).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const cleanTitle = (text: string) => text.replace(/^\s*\d{1,3}[.、\s_-]+/u, '').replace(/\[(?:mqms\d*|mqms|www\.[^\]]+)\]/giu, '').trim()
const unknown = /^(?:未知(?:歌曲|歌手)?|unknown(?:artist|title)?|群星|网络歌手|非主流歌手|variousartists|va|soundtrack)$/iu
const instrumental = /纯音乐|伴奏|卡拉[ok]|instrumental|karaoke|off[ -]?vocal/iu
const version = (name: string) => [
    /\blive\b|现场|演唱会/iu,
    /remix|\bmix\b|混音|重混/iu,
    /acoustic|不插电/iu,
    /cover|翻唱/iu,
    /粤语|粵語|\[粵\]|\[粤\]|\(粤\)|\(粵\)/iu,
    /英文版|英语版|english version/iu,
].map(rule => rule.test(name) ? '1' : '0').join('')

export const lyricDuration = (value: any): number => {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0
    const parts = String(value || '').split(':')
    if (!parts.length || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) return 0
    return parts.reduce((total, part) => total * 60 + Number(part), 0)
}

const singerGroups = (value: string) => String(value || '').split(/\s*(?:[、/&,;；，]|\bfeat\.?\s|\bfeaturing\s)\s*/iu).filter(Boolean).map(part => {
    const aliases = [part, part.replace(/[（(][^）)]*[）)]/gu, '')]
    for (const match of part.matchAll(/[（(]([^）)]+)[）)]/gu)) aliases.push(match[1])
    return aliases.map(normalize).filter(Boolean)
})
const aliasMatches = (left: string, right: string) => left === right ||
    (Math.min(left.length, right.length) >= 3 && Math.max(left.length, right.length) <= Math.min(left.length, right.length) * 2 && (left.includes(right) || right.includes(left)))
const singersMatch = (left: string, right: string) => {
    const a = singerGroups(left)
    const b = singerGroups(right)
    return a.length > 0 && a.length === b.length && a.every(group => b.some(other => group.some(x => other.some(y => aliasMatches(x, y)))))
}

export const localMusicInfoSkipReason = (song: LyricSong): string | null => {
    if (!song.name || !song.singer || unknown.test(normalize(song.name)) || unknown.test(normalize(song.singer)) ||
        !/\p{L}/u.test(song.name) || /https?:|www\.|QQ\s*\d{5,}/iu.test(`${song.name} ${song.singer}`) || lyricDuration(song.interval) <= 0) return '缺少可靠的歌名、歌手或时长'
    return null
}

export const localLyricSkipReason = (song: LyricSong): string | null => {
    if (song.hasEmbedLyric) return '已有内嵌歌词'
    if (instrumental.test(`${song.name} ${song.singer} ${path.basename(song.filename)}`)) return '纯音乐或伴奏'
    return localMusicInfoSkipReason(song)
}

/** Match a recording without associating files or changing tags. Covers also support instrumental recordings. */
export const matchLocalMusicCandidates = (local: LyricSong, candidates: any[], allowInstrumental = false) => {
    const name = cleanTitle(local.name)
    const duration = lyricDuration(local.interval)
    return candidates.filter(song => {
        const candidateName = cleanTitle(String(song.name || ''))
        return normalize(candidateName) === normalize(name) && version(candidateName) === version(name) &&
            (allowInstrumental || !instrumental.test(candidateName)) && singersMatch(local.singer, String(song.singer || '')) &&
            lyricDuration(song.interval) > 0 && Math.abs(lyricDuration(song.interval) - duration) <= 2
    }).sort((a, b) => Math.abs(lyricDuration(a.interval) - duration) - Math.abs(lyricDuration(b.interval) - duration))
}

export const matchLyricCandidates = (local: LyricSong, candidates: any[]) => matchLocalMusicCandidates(local, candidates)
export { normalize as normalizeMusicMatchText, cleanTitle as cleanMusicMatchTitle }

export const usableLyric = (value: any): string | null => {
    const raw = typeof value === 'string' ? value : value?.lyric || value?.lrc
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1024 * 1024 || raw.includes('\0') || /^\s*(?:<!doctype|<html|\{)/iu.test(raw)) return null
    const text = raw.replace(/^\ufeff/u, '').replace(/\r\n?/gu, '\n').trim()
    const lines = text.split('\n').map(line => line.replace(/\[[^\]]*\]/gu, '').trim()).filter(Boolean)
        .filter(line => !/^(?:作词|作曲|编曲|词|曲|制作人|混音|监制|录音|发行|出品|演唱|lyricist|composer|arranger|written by)\s*[:：]/iu.test(line))
    if (lines.some(line => /^(?:纯音乐[，,。\s]*(?:请欣赏)?|此歌曲为没有填词的纯音乐.*|暂无歌词|歌词暂缺|no lyrics|instrumental)$/iu.test(line))) return null
    if (new Set(lines).size < 3 || lines.join('').length < 12) return null
    return text + '\n'
}

export const withLyricTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([promise, new Promise<never>((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
}

export const createCustomLyricsManager = (deps: Dependencies) => {
    const jobs = new Map<string, LyricJob>()
    const cancelled = new Set<string>()
    const sources = deps.sources || ['wy', 'tx', 'kw']
    const timeout = deps.timeoutMs ?? 8000
    const delay = deps.delayMs ?? 120

    const persist = (username: string, job: LyricJob) => {
        const target = deps.reportPath(username)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const temporary = target + '.tmp'
        fs.writeFileSync(temporary, JSON.stringify(job, null, 2), { mode: 0o600 })
        fs.renameSync(temporary, target)
    }
    const get = (username: string): LyricJob | null => {
        if (jobs.has(username)) return structuredClone(jobs.get(username)!)
        try {
            const job: LyricJob = JSON.parse(fs.readFileSync(deps.reportPath(username), 'utf8'))
            if (!job.id || !Array.isArray(job.details)) return null
            if (job.status === 'running' || job.status === 'cancelling') {
                job.status = 'interrupted'
                job.finishedAt = new Date().toISOString()
                job.message = '服务器重启中断了任务，可重新补全，已有歌词会自动跳过'
                persist(username, job)
            }
            jobs.set(username, job)
            return structuredClone(job)
        } catch { return null }
    }

    const run = async (username: string, job: LyricJob, requested?: string[]) => {
        const configuredRoot = deps.getRoot(username)
        if (!configuredRoot) throw new Error('自定义音乐目录未启用')
        const root = fs.realpathSync(configuredRoot)
        const items = await deps.list(username)
        const byFile = new Map(items.map(item => [item.filename, item]))
        const filenames = requested || items.map(item => item.filename)
        job.total = filenames.length
        persist(username, job)
        const failures = new Map<string, number>()
        const cache = new Map<string, { text: string, source: string, songmid: string }>()

        const complete = (song: LyricSong, status: 'downloaded' | 'skipped' | 'failed', reason: string, match?: { source: string, songmid: string }) => {
            job.details.push({ filename: song.filename, name: song.name, status, reason, ...match })
            job.processed++
            job[status]++
            persist(username, job)
        }

        for (const filename of filenames) {
            if (cancelled.has(job.id)) break
            if (!deps.canWrite(username) || deps.getRoot(username) !== configuredRoot || fs.realpathSync(configuredRoot) !== root) {
                job.message = '写入权限或音乐目录已改变，任务已停止'
                cancelled.add(job.id)
                break
            }
            const song = byFile.get(filename) || { filename, name: path.basename(filename), singer: '' }
            job.current = song.name
            persist(username, job)
            try {
                const resolved = resolveLyricSong(root, filename)
                if (exists(resolved.lyricFile)) { complete(song, 'skipped', '已有外置歌词'); continue }
                const skipReason = localLyricSkipReason(song)
                if (skipReason) { complete(song, 'skipped', skipReason); continue }
                const originalStat = fs.statSync(resolved.file)
                const query = `${cleanTitle(toSimplified(song.name))} ${toSimplified(song.singer)}`
                const key = `${normalize(song.name)}\0${normalize(song.singer)}\0${lyricDuration(song.interval)}`
                let found = cache.get(key)
                let hadMatch = false
                let hadError = false
                let searched = false
                for (const source of sources) {
                    if (found || cancelled.has(job.id)) break
                    if ((failures.get(source + ':search') || 0) >= 3 || (failures.get(source + ':lyric') || 0) >= 3) continue
                    let candidates: any[]
                    try {
                        const result = await withLyricTimeout(deps.search(source, query), timeout)
                        candidates = matchLyricCandidates(song, result || [])
                        searched = true
                        failures.set(source + ':search', 0)
                    } catch {
                        hadError = true
                        failures.set(source + ':search', (failures.get(source + ':search') || 0) + 1)
                        continue
                    }
                    for (const candidate of candidates.slice(0, 2)) {
                        if (cancelled.has(job.id)) break
                        hadMatch = true
                        try {
                            const result = await withLyricTimeout(deps.fetchLyrics(source, candidate), timeout)
                            failures.set(source + ':lyric', 0)
                            const text = usableLyric(result)
                            if (text) {
                                found = { text, source, songmid: String(candidate.songmid || candidate.id || '') }
                                cache.set(key, found)
                                break
                            }
                        } catch {
                            hadError = true
                            failures.set(source + ':lyric', (failures.get(source + ':lyric') || 0) + 1)
                        }
                    }
                }
                if (cancelled.has(job.id)) break
                if (!found) {
                    complete(song, 'skipped', hadMatch ? (hadError ? '获取歌词失败，已跳过' : '未找到有效歌词或为纯音乐') :
                        (!searched ? '搜索服务暂不可用，已跳过' : '没有歌名、歌手、版本及时长均匹配的结果'))
                    continue
                }
                if (!deps.canWrite(username) || deps.getRoot(username) !== configuredRoot) { cancelled.add(job.id); break }
                const current = resolveLyricSong(root, filename)
                const currentStat = fs.statSync(current.file)
                if (current.file !== resolved.file || currentStat.size !== originalStat.size || currentStat.mtimeMs !== originalStat.mtimeMs) {
                    complete(song, 'skipped', '匹配期间音频文件已改变'); continue
                }
                // Exclusive creation also protects an existing file or symlink
                // that appeared while searching. Audio files are never opened for writing.
                try { fs.writeFileSync(current.lyricFile, found.text, { encoding: 'utf8', flag: 'wx' }) } catch (error: any) {
                    if (error.code === 'EEXIST') { complete(song, 'skipped', '已有外置歌词'); continue }
                    throw error
                }
                deps.onSaved(username, filename, path.relative(root, current.lyricFile).replace(/\\/gu, '/'))
                complete(song, 'downloaded', '已保存同名 LRC 歌词', { source: found.source, songmid: found.songmid })
            } catch {
                complete(song, 'failed', '文件不可访问、路径无效或歌词写入失败')
            } finally {
                if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
        job.status = cancelled.has(job.id) ? 'cancelled' : 'completed'
        job.current = ''
        job.finishedAt = new Date().toISOString()
        cancelled.delete(job.id)
        persist(username, job)
    }

    return {
        get,
        start(username: string, filenames?: string[]) {
            if (!deps.canWrite(username)) throw new Error('管理员未允许写入自定义目录')
            if (!deps.getRoot(username)) throw new Error('自定义音乐目录未启用')
            if (filenames !== undefined && (!Array.isArray(filenames) || filenames.length > 10000 || filenames.some(name => typeof name !== 'string' || name.length > 4096))) throw new Error('无效的歌曲列表')
            const previous = get(username)
            if (previous && (previous.status === 'running' || previous.status === 'cancelling')) return previous
            const job: LyricJob = { id: crypto.randomUUID(), status: 'running', total: 0, processed: 0, downloaded: 0, skipped: 0, failed: 0,
                current: '', startedAt: new Date().toISOString(), details: [] }
            jobs.set(username, job)
            persist(username, job)
            void run(username, job, filenames ? [...new Set(filenames)] : undefined).catch(() => {
                job.status = 'failed'
                job.current = ''
                job.finishedAt = new Date().toISOString()
                job.message = '任务无法继续，请检查音乐目录及服务器存储权限'
                try { persist(username, job) } catch { /* GET still exposes the in-memory failure. */ }
            })
            return structuredClone(job)
        },
        cancel(username: string, id: string) {
            const job = jobs.get(username)
            if (!job || job.id !== id || (job.status !== 'running' && job.status !== 'cancelling')) return false
            cancelled.add(id)
            job.status = 'cancelling'
            persist(username, job)
            return true
        },
    }
}
