import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { compatibleLocalAudio } from './compatibleLocalAudio'
import { getCustomCover, getCustomMusicDir, getCustomMusicList, syncCustomIndex, getCustomLocalLyrics } from './customMusicManager'

export const CUSTOM_DIRECTORY_PLAYLIST_ID = 'custom-directory'
export const isCustomDirectoryId = (id: string) => id.startsWith('localdir_')

export interface CustomDirectoryMusic extends LX.Music.MusicInfoLocal {
    meta: LX.Music.MusicInfoLocal['meta'] & { albumId: string }
    customFile: string
    fileSize: number
    bitRate: number
    modifiedAt: number
}

const contentTypes: Record<string, string> = {
    mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4',
    ogg: 'audio/ogg', wav: 'audio/wav', ape: 'audio/x-ape',
}
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
const within = (root: string, file: string) => {
    const relative = path.relative(root, file)
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const validRelativeFile = (filename: string) => {
    if (typeof filename !== 'string' || !filename || filename.includes('\0') || path.isAbsolute(filename)) return false
    const root = path.resolve('/custom-library')
    return within(root, path.resolve(root, filename)) && !!contentTypes[path.extname(filename).slice(1).toLowerCase()]
}

/** Use per-user IDs, never share local paths through the global online-song cache. */
export const getCustomDirectoryMusic = async (username: string): Promise<CustomDirectoryMusic[]> => {
    if (!global.lx.config['user.enableCustomMusicDir'] || !getCustomMusicDir(username)) return []
    // Cover bytes are checked only when that particular cover is requested.
    const items = await getCustomMusicList(username, { includeCoverDetails: false })
    return items.filter(item => validRelativeFile(item.filename)).map((item): CustomDirectoryMusic => {
        const id = `localdir_${hash(`${username}\0${item.filename}`)}`
        const albumName = item.album || 'Unknown Album'
        return {
            id,
            name: item.name,
            singer: item.singer || 'Unknown Artist',
            source: 'local',
            interval: item.interval || '0',
            customFile: item.filename,
            fileSize: item.size,
            bitRate: item.bitrate || 0,
            modifiedAt: item.mtime,
            meta: {
                songId: id,
                albumName,
                albumId: hash(`${item.singer}\0${albumName}`),
                filePath: item.filename,
                ext: path.extname(item.filename).slice(1).toLowerCase(),
            },
        }
    })
}

export const findCustomDirectoryMusic = async (username: string, id: string) => {
    if (!isCustomDirectoryId(id)) return null
    return (await getCustomDirectoryMusic(username)).find(music => music.id === id) || null
}

export const refreshCustomDirectoryMusic = async (username: string) => {
    if (global.lx.config['user.enableCustomMusicDir'] && getCustomMusicDir(username)) {
        await syncCustomIndex(username)
    }
    return getCustomDirectoryMusic(username)
}

/** Validate the current user's root again at read time, including symlink escapes. */
export const resolveCustomDirectoryFile = (username: string, music: CustomDirectoryMusic) => {
    if (!global.lx.config['user.enableCustomMusicDir'] || !validRelativeFile(music.customFile)) return null
    const configuredRoot = getCustomMusicDir(username)
    if (!configuredRoot) return null
    try {
        const root = fs.realpathSync(configuredRoot)
        const file = fs.realpathSync(path.join(root, music.customFile))
        if (!within(root, file) || !fs.statSync(file).isFile()) return null
        return file
    } catch {
        return null
    }
}

export const getCustomDirectoryCover = (username: string, music: CustomDirectoryMusic) => {
    if (!resolveCustomDirectoryFile(username, music)) return null
    return getCustomCover(music.customFile, username)
}

export const getCustomDirectoryLyrics = (username: string, music: CustomDirectoryMusic): string => {
    if (!resolveCustomDirectoryFile(username, music)) return ''
    return getCustomLocalLyrics(music.customFile, username).lrc
}

export const customDirectoryQuality = (music: CustomDirectoryMusic) => ({
    bitRate: music.bitRate,
    size: music.fileSize,
    suffix: music.meta.ext,
    contentType: contentTypes[music.meta.ext] || 'application/octet-stream',
})

export const serveCustomDirectoryMusic = async (
    req: http.IncomingMessage, res: http.ServerResponse, username: string, music: CustomDirectoryMusic,
) => {
    let file = resolveCustomDirectoryFile(username, music)
    if (!file) {
        res.writeHead(404)
        res.end('File not found')
        return
    }
    const original = file
    const download = /\/download(?:\.view)?$/.test((req.url || '').split('?')[0])
    if (!download) {
        try {
            file = await compatibleLocalAudio(file, path.join(global.lx.dataPath, 'cache', 'compatible-audio'))
        } catch {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '5' })
            res.end('DTS-WAV decoding unavailable. Install FFmpeg on the server and retry.')
            return
        }
    }
    const size = fs.statSync(file).size
    let start = 0
    let end = size - 1
    const range = req.headers.range
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (match && (match[1] || match[2])) {
            if (match[1]) {
                start = Number(match[1])
                end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
            } else {
                start = Math.max(0, size - Number(match[2]))
            }
        } else {
            start = -1
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' })
            res.end()
            return
        }
    }
    const headers: Record<string, string | number> = {
        'Content-Type': file === original ? customDirectoryQuality(music).contentType : 'audio/flac',
        'Content-Length': Math.max(0, end - start + 1),
        'Accept-Ranges': 'bytes',
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    if (download) {
        headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`
    }
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD' || size === 0) return res.end()
    const stream = fs.createReadStream(file, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
}
