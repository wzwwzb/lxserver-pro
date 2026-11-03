import crypto from 'crypto'

/** The wire format is shared with the Android and HarmonyOS clients. */
export interface ListenRoomSong {
    id: string
    title: string
    artist: string
    album: string
    coverArt: string
    albumId: string
    duration: number
}

export interface ListenRoomSnapshot {
    roomId: string
    revision: number
    serverTimeMs: number
    changedAtMs: number
    positionMs: number
    playing: boolean
    song: ListenRoomSong | null
    members: string[]
}

interface ListenRoom {
    id: string
    creator: string
    revision: number
    changedAtMs: number
    lastActivityMs: number
    positionMs: number
    playing: boolean
    song: ListenRoomSong | null
    // Used only to resolve an already-authorized local file for another member.
    songOwner: string | null
    members: Set<string>
}

export class ListenRoomError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message)
    }
}

export const LISTEN_ROOM_METHODS = new Set([
    'createListenRoom', 'joinListenRoom', 'getListenRoom',
    'updateListenRoom', 'leaveListenRoom',
])

// Memory only: a restart closes rooms rather than persisting invitations or playback.
export const LISTEN_ROOM_IDLE_MS = 2 * 60 * 60 * 1000
export const LISTEN_ROOM_MAX_ROOMS = 256
export const LISTEN_ROOM_MAX_MEMBERS = 32
export const LISTEN_ROOM_MAX_CREATED_PER_USER = 16
export const LISTEN_ROOM_MAX_BODY_BYTES = 16 * 1024
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/

const noRoom = () => new ListenRoomError(70, 'Room not found or unavailable')
const invalidParameter = () => new ListenRoomError(10, 'Invalid listen-room parameters')

/** Never put passwords, access tokens or credential-bearing URLs into shared metadata. */
function isUnsafeMetadata(value: string, identifiersOnly: boolean): boolean {
    if (/[\u0000-\u001f\u007f]/.test(value)) return true
    if (identifiersOnly && /^(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|\/rest\/)/i.test(value.trim())) return true
    // Reject embedded URL credentials and common authentication query parameters.
    const urls = value.match(/(?:https?:\/\/|\/\/)[^\s<>"']+/gi) || []
    for (const raw of urls) {
        try {
            const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
            if (url.username || url.password) return true
            if (/\/(?:stream|download)(?:\.view)?\/?$/i.test(url.pathname)) return true
            for (const key of url.searchParams.keys()) {
                if (/^(?:u|p|t|s|password|passwd|pass|token|access[_-]?token|auth(?:orization|_?key)?|api[_-]?key|key|signature|sig|sign|cookie|session|x-amz-.+)$/i.test(key)) return true
            }
        } catch {
            return true
        }
    }
    // Also reject relative Subsonic URLs and credentials embedded without a scheme.
    return /(?:^|[?&])(?:p|password|passwd|token|access_token|auth|authorization|signature|sig|sign|cookie|session|t|s)=/i.test(value)
}

function metadata(params: URLSearchParams, key: string, maxBytes: number, identifiersOnly = false): string {
    const value = params.get(key) ?? ''
    if (Buffer.byteLength(value, 'utf8') > maxBytes || isUnsafeMetadata(value, identifiersOnly)) throw invalidParameter()
    return value
}

function parseUpdate(params: URLSearchParams): { song: ListenRoomSong | null, positionMs: number, playing: boolean } {
    if (!params.has('songId') || !params.has('positionMs') || !params.has('playing')) throw invalidParameter()
    for (const forbidden of ['p', 'password', 'passwd', 'streamUrl', 'audioUrl', 'url', 'accessToken']) {
        if (params.has(forbidden)) throw invalidParameter()
    }
    const id = metadata(params, 'songId', 1024, true)
    const title = metadata(params, 'title', 1024)
    const artist = metadata(params, 'artist', 1024)
    const album = metadata(params, 'album', 1024)
    const coverArt = metadata(params, 'coverArt', 2048)
    const albumId = metadata(params, 'albumId', 1024, true)
    const durationText = params.get('duration') ?? '0'
    const positionText = params.get('positionMs') ?? ''
    const playingText = params.get('playing')
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(durationText) || !/^(?:0|[1-9]\d*)$/.test(positionText)) throw invalidParameter()
    const duration = Number(durationText)
    const positionMs = Number(positionText)
    if (!Number.isFinite(duration) || duration > 1_000_000_000 || !Number.isSafeInteger(positionMs)) throw invalidParameter()
    if (playingText !== 'true' && playingText !== 'false') throw invalidParameter()
    const song = id ? { id, title, artist, album, coverArt, albumId, duration } : null
    return { song, positionMs, playing: playingText === 'true' }
}

/**
 * Operations are deliberately synchronous: each room read/modify/write completes
 * in one event-loop turn, so concurrent HTTP handlers cannot interleave a change.
 */
export class ListenRoomStore {
    private readonly rooms = new Map<string, ListenRoom>()

    constructor(
        private readonly now: () => number = Date.now,
        private readonly idleMs = LISTEN_ROOM_IDLE_MS,
        private readonly maxRooms = LISTEN_ROOM_MAX_ROOMS,
        private readonly maxMembers = LISTEN_ROOM_MAX_MEMBERS,
        private readonly maxCreatedPerUser = LISTEN_ROOM_MAX_CREATED_PER_USER,
    ) { }

    private prune(now: number) {
        for (const [id, room] of this.rooms) {
            if (now - room.lastActivityMs >= this.idleMs) this.rooms.delete(id)
        }
    }

    private lookup(id: string, now: number): ListenRoom {
        if (!ROOM_ID_PATTERN.test(id)) throw noRoom()
        const room = this.rooms.get(id)
        if (!room || now - room.lastActivityMs >= this.idleMs) {
            if (room) this.rooms.delete(id)
            throw noRoom()
        }
        return room
    }

    private member(id: string, username: string, now: number): ListenRoom {
        const room = this.lookup(id, now)
        if (!room.members.has(username)) throw noRoom()
        return room
    }

    private snapshot(room: ListenRoom, now: number): ListenRoomSnapshot {
        return {
            roomId: room.id,
            revision: room.revision,
            serverTimeMs: now,
            changedAtMs: room.changedAtMs,
            positionMs: room.positionMs,
            playing: room.playing,
            song: room.song ? { ...room.song } : null,
            members: [...room.members],
        }
    }

    create(username: string): ListenRoomSnapshot {
        const now = this.now()
        this.prune(now)
        let created = 0
        for (const room of this.rooms.values()) if (room.creator === username) created++
        if (this.rooms.size >= this.maxRooms || created >= this.maxCreatedPerUser) {
            throw new ListenRoomError(0, 'Room capacity reached')
        }
        let id: string
        do { id = crypto.randomBytes(24).toString('base64url') } while (this.rooms.has(id))
        const room: ListenRoom = {
            id, creator: username, revision: 1, changedAtMs: now, lastActivityMs: now,
            positionMs: 0, playing: false, song: null, songOwner: null,
            members: new Set([username]),
        }
        this.rooms.set(id, room)
        return this.snapshot(room, now)
    }

    join(id: string, username: string): ListenRoomSnapshot {
        const now = this.now()
        const room = this.lookup(id, now)
        if (!room.members.has(username)) {
            if (room.members.size >= this.maxMembers) throw new ListenRoomError(0, 'Room capacity reached')
            room.members.add(username)
            room.revision++
        }
        room.lastActivityMs = now
        return this.snapshot(room, now)
    }

    get(id: string, username: string): ListenRoomSnapshot {
        const now = this.now()
        const room = this.member(id, username, now)
        room.lastActivityMs = now
        return this.snapshot(room, now)
    }

    update(id: string, username: string, params: URLSearchParams): ListenRoomSnapshot {
        const now = this.now()
        const room = this.member(id, username, now)
        const update = parseUpdate(params)
        // The updater can be a different member controlling the same shared song.
        const sameSong = !!update.song && room.song?.id === update.song.id
        room.songOwner = update.song ? (sameSong ? room.songOwner : username) : null
        room.song = update.song
        room.positionMs = update.positionMs
        room.playing = update.playing
        room.changedAtMs = now
        room.lastActivityMs = now
        room.revision++
        return this.snapshot(room, now)
    }

    leave(id: string, username: string): void {
        const now = this.now()
        const room = this.member(id, username, now)
        room.members.delete(username)
        room.revision++
        room.lastActivityMs = now
        if (!room.members.size) this.rooms.delete(id)
    }

    /** Check current membership again after any asynchronous file lookup. */
    sharedSongOwners(username: string, id: string): string[] {
        const now = this.now()
        this.prune(now)
        const owners = new Set<string>()
        for (const room of this.rooms.values()) {
            if (room.members.has(username) && room.song?.id === id && room.songOwner && room.songOwner !== username) {
                owners.add(room.songOwner)
            }
        }
        return [...owners]
    }
}

export const listenRoomStore = new ListenRoomStore()
