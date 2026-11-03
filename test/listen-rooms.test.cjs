const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')
const { ListenRoomStore, ListenRoomError } = require('../server/server/listenRooms')

const update = (overrides = {}) => new URLSearchParams({
    songId: 'wy_42', title: '一起听', artist: '演唱者', album: '专辑',
    coverArt: 'https://cdn.example/cover.jpg?size=200', albumId: 'alb_wy_7',
    duration: '212.5', positionMs: '12000', playing: 'true', ...overrides,
})

test('listen-room snapshots, access control, limits and idle expiry', () => {
    let now = 1_700_000_000_000
    const rooms = new ListenRoomStore(() => now, 1000, 2, 2, 1)
    const created = rooms.create('alice')
    assert.match(created.roomId, /^[A-Za-z0-9_-]{32}$/)
    assert.deepEqual(created.members, ['alice'])
    assert.equal(created.song, null)
    assert.equal(created.revision, 1)
    assert.equal(created.changedAtMs, now)
    assert.equal(created.playing, false)
    assert.throws(() => rooms.create('alice'), ListenRoomError)
    assert.throws(() => rooms.get(created.roomId, 'bob'), ListenRoomError)
    assert.throws(() => rooms.update(created.roomId, 'bob', update()), ListenRoomError)
    assert.throws(() => rooms.leave(created.roomId, 'bob'), ListenRoomError)

    now += 100
    const joined = rooms.join(created.roomId, 'bob')
    assert.deepEqual(joined.members, ['alice', 'bob'])
    assert.equal(joined.revision, 2)
    assert.equal(joined.changedAtMs, created.changedAtMs)
    assert.equal(rooms.join(created.roomId, 'bob').revision, 2)
    assert.throws(() => rooms.join(created.roomId, 'charlie'), ListenRoomError)
    const changed = rooms.update(created.roomId, 'bob', update())
    assert.deepEqual(changed.song, { id: 'wy_42', title: '一起听', artist: '演唱者', album: '专辑',
        coverArt: 'https://cdn.example/cover.jpg?size=200', albumId: 'alb_wy_7', duration: 212.5 })
    assert.equal(changed.revision, 3)
    assert.equal(changed.positionMs, 12000)
    assert.equal(changed.changedAtMs, now)
    now += 500
    const polled = rooms.get(created.roomId, 'alice')
    assert.equal(polled.serverTimeMs, now)
    assert.equal(polled.changedAtMs, changed.changedAtMs)
    assert.equal(polled.positionMs, 12000, 'position is the base at changedAtMs')
    assert.equal(polled.revision, changed.revision)
    polled.members.push('not-a-member')
    polled.song.title = 'mutated snapshot'
    assert.deepEqual(rooms.get(created.roomId, 'bob').members, ['alice', 'bob'])
    assert.equal(rooms.get(created.roomId, 'bob').song.title, '一起听')
    rooms.leave(created.roomId, 'bob')
    assert.throws(() => rooms.get(created.roomId, 'bob'), ListenRoomError)
    assert.equal(rooms.get(created.roomId, 'alice').revision, 4)
    now += 1000
    assert.throws(() => rooms.get(created.roomId, 'alice'), ListenRoomError)
    assert.notEqual(rooms.create('alice').roomId, created.roomId, 'expired room frees capacity')
})

test('listen-room metadata cannot carry passwords, signed URLs or unbounded values', () => {
    const rooms = new ListenRoomStore()
    const id = rooms.create('alice').roomId
    for (const values of [
        { songId: 'https://example.test/rest/stream.view?id=1&t=secret' },
        { songId: '/rest/stream.view?id=1' },
        { coverArt: 'https://cdn.example/cover.jpg?token=secret' },
        { coverArt: 'https://user:secret@cdn.example/cover.jpg' },
        { title: 'https://example.test/rest/stream.view?id=1&u=a&t=b&s=c' },
        { p: 'not-allowed' }, { streamUrl: 'not-allowed' },
        { title: 'x'.repeat(1025) }, { positionMs: '-1' },
        { positionMs: '9007199254740992' }, { playing: '1' }, { duration: 'NaN' },
    ]) {
        assert.throws(() => rooms.update(id, 'alice', update(values)), ListenRoomError)
        assert.equal(rooms.get(id, 'alice').revision, 1, 'invalid updates must not mutate state')
    }
    const empty = rooms.update(id, 'alice', update({ songId: '', playing: 'false', positionMs: '0' }))
    assert.equal(empty.song, null)
    assert.equal(empty.playing, false)
})

test('Subsonic listen-room POST API, race handling, log privacy and per-user local audio', { timeout: 90000 }, async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-listen-room-'))
    const data = path.join(tmp, 'data')
    const logs = path.join(tmp, 'logs')
    const shared = path.join(tmp, 'shared')
    for (const dir of [data, logs, shared]) fs.mkdirSync(dir)
    const audio = Buffer.alloc(1644, 0x22)
    audio.write('RIFF', 0)
    audio.writeUInt32LE(audio.length - 8, 4)
    audio.write('WAVEfmt ', 8)
    audio.writeUInt32LE(16, 16)
    audio.writeUInt16LE(1, 20)
    audio.writeUInt16LE(1, 22)
    audio.writeUInt32LE(8000, 24)
    audio.writeUInt32LE(16000, 28)
    audio.writeUInt16LE(2, 32)
    audio.writeUInt16LE(16, 34)
    audio.write('data', 36)
    audio.writeUInt32LE(audio.length - 44, 40)
    const file = path.join(shared, 'test.wav')
    fs.writeFileSync(file, audio)
    fs.writeFileSync(path.join(shared, 'test.lrc'), '[00:01.00]fixture lyrics')
    fs.writeFileSync(path.join(shared, 'custom_index.json'), JSON.stringify({
        'test.wav': { id: 'fixture', name: 'Shared', singer: 'Fixture', album: 'Album',
            interval: '0:10', source: 'local', quality: 'flac', filename: 'test.wav',
            folder: 'custom', size: audio.length, mtime: fs.statSync(file).mtimeMs,
            ext: '.wav', bitrate: 128, hasLyric: true },
    }))
    const users = [
        { name: 'alice', password: 'fixture-alice-password', enableCustomMusicDir: true, customMusicDir: shared },
        { name: 'bob', password: 'fixture-bob-password', enableCustomMusicDir: true, customMusicDir: shared },
        { name: 'charlie', password: 'fixture-charlie-password', enableCustomMusicDir: false, customMusicDir: shared },
    ]
    fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(users))
    const configPath = path.join(tmp, 'config.js')
    fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({
        users, 'user.enableCustomMusicDir': true, 'admin.password': 'fixture-admin-password',
        'subsonic.enable': true, 'subsonic.enableDebug': true, 'subsonic.onlineSearch': false,
        'subsonic.publicLeaderboards': false, 'webdav.enable': false,
        'configBackup.enable': false, disableTelemetry: true,
    })}`)
    const listener = net.createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const env = { ...process.env, DATA_PATH: data, LOG_PATH: logs, CONFIG_PATH: configPath,
        PORT: String(port), NODE_ENV: 'production', DISABLE_TELEMETRY: 'true', WEBDAV_ENABLE: 'false' }
    for (const key of Object.keys(env)) if (/^(LX_USER_|ADMIN_PASSWORD|USER_ENABLE_|WEBPLAYER_PASSWORD)/.test(key)) delete env[key]
    const child = spawn(process.execPath, [path.resolve(__dirname, '../index.js')], { env, stdio: 'ignore' })
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM')
            await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))])
            if (child.exitCode === null) child.kill('SIGKILL')
        }
        fs.rmSync(tmp, { recursive: true, force: true })
    })
    const auth = username => {
        const user = users.find(item => item.name === username)
        const salt = 'fixture-salt-private'
        return { u: username, t: crypto.createHash('md5').update(user.password + salt).digest('hex'),
            s: salt, v: '1.16.1', c: 'listen-test', f: 'json' }
    }
    const form = async (method, username, fields = {}, query = '') => {
        const res = await fetch(`http://127.0.0.1:${port}/rest/${method}.view${query}`, {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ ...auth(username), ...fields }), signal: AbortSignal.timeout(10000),
        })
        return { response: res, body: (await res.json())['subsonic-response'] }
    }
    const get = async (method, username, fields = {}) => {
        const query = new URLSearchParams({ ...auth(username), ...fields })
        return fetch(`http://127.0.0.1:${port}/rest/${method}.view?${query}`, { signal: AbortSignal.timeout(10000) })
    }
    let ready = false
    for (let i = 0; i < 200; i++) {
        assert.equal(child.exitCode, null, 'fixture server exited before listening')
        try {
            const body = (await (await get('ping', 'alice')).json())['subsonic-response']
            if (body.status === 'ok') { ready = true; break }
        } catch { /* wait for server */ }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(ready, 'fixture server must start')

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/rest/createListenRoom.view`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'f=json',
    })
    assert.equal((await unauthenticated.json())['subsonic-response'].error.code, 40)
    const wrong = await form('createListenRoom', 'alice', { t: 'wrong-token' })
    assert.equal(wrong.body.error.code, 40)
    const plainPassword = await form('createListenRoom', 'alice', { p: 'fixture-alice-password' })
    assert.equal(plainPassword.body.status, 'failed')
    const getAttempt = await get('createListenRoom', 'alice')
    assert.equal((await getAttempt.json())['subsonic-response'].status, 'failed')

    const created = await form('createListenRoom', 'alice')
    assert.equal(created.body.status, 'ok')
    assert.equal(created.response.headers.get('cache-control'), 'no-store')
    const room = created.body.listenRoom
    assert.match(room.roomId, /^[A-Za-z0-9_-]{32}$/)
    assert.deepEqual(room.members, ['alice'])
    assert.equal((await form('getListenRoom', 'bob', { roomId: room.roomId })).body.status, 'failed')
    assert.equal((await form('updateListenRoom', 'bob', { roomId: room.roomId, ...Object.fromEntries(update()) })).body.status, 'failed')
    assert.equal((await form('leaveListenRoom', 'bob', { roomId: room.roomId })).body.status, 'failed')
    const joined = (await form('joinListenRoom', 'bob', { roomId: room.roomId })).body.listenRoom
    assert.deepEqual(joined.members, ['alice', 'bob'])

    // Actual parallel HTTP requests must each produce a distinct revision.
    const changes = await Promise.all(Array.from({ length: 25 }, (_, i) =>
        form('updateListenRoom', i % 2 ? 'alice' : 'bob', {
            roomId: room.roomId, ...Object.fromEntries(update({ positionMs: String(i * 1000) })),
        })))
    assert.ok(changes.every(result => result.body.status === 'ok'))
    const revisions = changes.map(result => result.body.listenRoom.revision)
    assert.equal(new Set(revisions).size, 25)
    const last = changes.reduce((a, b) => a.body.listenRoom.revision > b.body.listenRoom.revision ? a : b).body.listenRoom
    const current = (await form('getListenRoom', 'alice', { roomId: room.roomId })).body.listenRoom
    assert.equal(current.revision, last.revision)
    assert.equal(current.positionMs, last.positionMs)
    assert.equal(current.changedAtMs, last.changedAtMs)
    assert.ok(current.serverTimeMs >= current.changedAtMs)
    assert.equal((await form('updateListenRoom', 'alice', {
        roomId: room.roomId, ...Object.fromEntries(update({ coverArt: 'https://cdn.example/pic?token=secret' })),
    })).body.status, 'failed')
    assert.equal((await form('getListenRoom', 'alice', { roomId: room.roomId })).body.listenRoom.revision, current.revision)

    const alicePlaylist = (await (await get('getPlaylist', 'alice', { id: 'custom-directory' })).json())['subsonic-response']
    const bobPlaylist = (await (await get('getPlaylist', 'bob', { id: 'custom-directory' })).json())['subsonic-response']
    const aliceSong = alicePlaylist.playlist.entry[0]
    const bobSong = bobPlaylist.playlist.entry[0]
    assert.notEqual(aliceSong.id, bobSong.id, 'local song IDs are user-specific')
    assert.equal((await (await get('stream', 'bob', { id: aliceSong.id })).json())['subsonic-response'].status, 'failed')
    const localUpdate = { roomId: room.roomId, songId: aliceSong.id, title: aliceSong.title,
        artist: aliceSong.artist, album: aliceSong.album, coverArt: aliceSong.coverArt,
        albumId: aliceSong.albumId, duration: String(aliceSong.duration), positionMs: '1000', playing: 'true' }
    assert.equal((await form('updateListenRoom', 'alice', localUpdate)).body.status, 'ok')
    const bobStream = await get('stream', 'bob', { id: aliceSong.id })
    assert.equal(bobStream.status, 200)
    assert.deepEqual(Buffer.from(await bobStream.arrayBuffer()), audio)
    const bobLyrics = (await (await get('getLyricsBySongId', 'bob', { id: aliceSong.id })).json())['subsonic-response']
    assert.match(bobLyrics.lyrics.value, /fixture lyrics/)
    assert.equal((await form('joinListenRoom', 'charlie', { roomId: room.roomId })).body.status, 'ok')
    assert.equal((await (await get('stream', 'charlie', { id: aliceSong.id })).json())['subsonic-response'].status, 'failed')
    // The second member can pause without changing who owns the shared local ID.
    assert.equal((await form('updateListenRoom', 'bob', { ...localUpdate, playing: 'false' })).body.status, 'ok')
    assert.equal((await get('stream', 'bob', { id: aliceSong.id })).status, 200)
    assert.equal((await form('updateListenRoom', 'alice', { roomId: room.roomId, ...Object.fromEntries(update()) })).body.status, 'ok')
    assert.equal((await (await get('stream', 'bob', { id: aliceSong.id })).json())['subsonic-response'].status, 'failed',
        'a previously shared local ID stops resolving after the room changes tracks')
    assert.equal((await form('updateListenRoom', 'alice', localUpdate)).body.status, 'ok')
    assert.equal((await form('leaveListenRoom', 'bob', { roomId: room.roomId })).body.status, 'ok')
    assert.equal((await (await get('stream', 'bob', { id: aliceSong.id })).json())['subsonic-response'].status, 'failed')
    assert.equal((await get('stream', 'bob', { id: bobSong.id })).status, 200, 'own library remains accessible')

    // Query strings are redacted even if a legacy caller sends credentials there.
    const queryAuth = new URLSearchParams({ ...auth('alice'), roomId: room.roomId })
    assert.equal((await form('getListenRoom', 'alice', {}, `?${queryAuth}`)).body.status, 'ok')
    const oversized = await form('updateListenRoom', 'alice', { roomId: room.roomId, title: 'x'.repeat(20 * 1024) })
    assert.equal(oversized.body.status, 'failed')
    const chunked = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/rest/updateListenRoom.view', method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } }, res => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())['subsonic-response']))
            res.on('error', reject)
        })
        req.on('error', reject)
        req.write('title=')
        req.write('x'.repeat(20 * 1024))
        req.end()
    })
    assert.equal(chunked.status, 'failed', 'chunked bodies are subject to the same byte limit')
    assert.equal((await form('leaveListenRoom', 'charlie', { roomId: room.roomId })).body.status, 'ok')
    assert.equal((await form('leaveListenRoom', 'alice', { roomId: room.roomId })).body.status, 'ok')
    assert.equal((await form('joinListenRoom', 'bob', { roomId: room.roomId })).body.status, 'failed')

    await new Promise(resolve => setTimeout(resolve, 100))
    const logText = fs.readdirSync(logs).filter(name => /^(access|subsonic)/.test(name))
        .map(name => fs.readFileSync(path.join(logs, name), 'utf8')).join('\n')
    assert.ok(logText.includes('createListenRoom'), 'access log records the route')
    for (const secret of [room.roomId, auth('alice').t, auth('alice').s, users[0].password]) {
        assert.ok(!logText.includes(secret), 'room IDs and credentials must not appear in logs')
    }
})
