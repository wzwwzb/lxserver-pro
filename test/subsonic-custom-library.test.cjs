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
const { gunzipSync } = require('node:zlib')
const iconv = require('iconv-lite')
const { coverPng } = require('./fixtures/cover-image.cjs')

// Run against a built server (also works in the production Docker image).
test('Subsonic serves each user\'s custom directory without online sources', { timeout: 90000 }, async t => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-subsonic-'))
    const data = path.join(tmp, 'data')
    const aliceRoot = path.join(tmp, 'alice')
    const bobRoot = path.join(tmp, 'bob')
    const escapeRoot = path.join(tmp, 'escape')
    for (const dir of [data, aliceRoot, bobRoot, escapeRoot]) fs.mkdirSync(dir)
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
    const names = ['目录/01_测试 & song.wav', '02.wav', '03.wav']
    const makeIndex = (root, titles, tagOverrides = {}) => {
        const index = {}
        for (const [i, title] of titles.entries()) {
            const filename = names[i]
            const file = path.join(root, filename)
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, audio)
            index[filename] = {
                id: `fixture-${i}`, name: title, singer: 'Fixture Artist',
                album: i < 2 ? 'Fixture Album' : 'Second Album', interval: '0:10',
                source: 'local', quality: 'flac', filename, folder: 'custom',
                size: audio.length, mtime: fs.statSync(file).mtimeMs, ext: '.wav', bitrate: 128,
                hasLyric: false, ...tagOverrides,
            }
        }
        // A corrupted/stale index must not turn into arbitrary file access.
        index['bad-path'] = { ...Object.values(index)[0], filename: '../outside.wav' }
        index['absolute-path'] = { ...Object.values(index)[0], filename: path.join(tmp, 'outside.wav') }
        fs.writeFileSync(path.join(root, 'custom_index.json'), JSON.stringify(index))
    }
    makeIndex(aliceRoot, ['Fixture & Track', 'Second Track', 'Third Track'])
    makeIndex(bobRoot, ['Í»È»ºÃÏëÄã'], { singer: 'ÎåÔÂÌì', album: 'ºóÇà´ºÆÚµÄÊ«' })
    fs.writeFileSync(path.join(aliceRoot, '目录/01_测试 & song.lrc'), '[00:01.00]本地歌词 & lyrics\n[00:02.50]Second line')
    const coverImage = coverPng()
    fs.writeFileSync(path.join(aliceRoot, '目录/01_测试 & song.png'), coverImage)
    fs.writeFileSync(path.join(tmp, 'outside.wav'), audio)
    fs.symlinkSync(path.join(tmp, 'outside.wav'), path.join(escapeRoot, 'escape.wav'))
    fs.writeFileSync(path.join(escapeRoot, 'custom_index.json'), JSON.stringify({ escape: {
        id: 'escape', name: 'Escape Track', singer: 'Fixture Artist', album: 'Escape Album',
        filename: 'escape.wav', size: audio.length, mtime: 1700000000000, ext: '.wav',
    } }))
    const users = [
        { name: 'alice', password: 'test-alice-password', enableCustomMusicDir: true, customMusicDir: aliceRoot },
        { name: 'bob', password: 'test-bob-password', enableCustomMusicDir: true, customMusicDir: bobRoot },
        { name: 'disabled', password: 'test-disabled-password', enableCustomMusicDir: false, customMusicDir: aliceRoot },
        { name: 'escape', password: 'test-escape-password', enableCustomMusicDir: true, customMusicDir: escapeRoot },
        { name: 'writer', password: 'test-writer-password', enableCustomMusicDir: true, customMusicDir: aliceRoot, allowWriteCustomMusicDir: true },
    ]
    fs.writeFileSync(path.join(data, 'users.json'), JSON.stringify(users))
    const configPath = path.join(tmp, 'config.js')
    fs.writeFileSync(configPath, `module.exports = ${JSON.stringify({
        users, 'user.enableCustomMusicDir': true, 'admin.password': 'test-admin-password',
        'subsonic.enable': true, 'subsonic.onlineSearch': false,
        'subsonic.publicLeaderboards': false, 'webdav.enable': false,
        'configBackup.enable': false, disableTelemetry: true,
    })}`)
    const listener = net.createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    const app = path.resolve(__dirname, '../index.js')
    const env = { ...process.env, DATA_PATH: data, LOG_PATH: path.join(tmp, 'logs'), CONFIG_PATH: configPath,
        PORT: String(port), NODE_ENV: 'production', DISABLE_TELEMETRY: 'true', WEBDAV_ENABLE: 'false' }
    for (const key of Object.keys(env)) if (key.startsWith('LX_USER_')) delete env[key]
    const child = spawn(process.execPath, [app], { cwd: path.dirname(app), env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.resume()
    child.stderr.resume()
    t.after(async () => {
        if (child.exitCode === null) {
            const closed = once(child, 'exit')
            child.kill('SIGTERM')
            await closed
        }
        fs.rmSync(tmp, { recursive: true, force: true })
    })
    const request = async (method, params = {}, username = 'alice', options = {}) => {
        const password = users.find(user => user.name === username).password
        const salt = 'fixture-salt'
        const token = crypto.createHash('md5').update(password + salt).digest('hex')
        const query = new URLSearchParams({ u: username, t: token, s: salt, v: '1.16.1', c: 'test', f: 'json', ...params })
        return fetch(`http://127.0.0.1:${port}/rest/${method}.view?${query}`, {
            signal: AbortSignal.timeout(10000), ...options,
        })
    }
    const json = async (method, params, username) => (await (await request(method, params, username)).json())['subsonic-response']
    let ready = false
    for (let i = 0; i < 200; i++) {
        assert.equal(child.exitCode, null, 'fixture server exited before listening')
        try { if ((await json('ping')).status === 'ok') { ready = true; break } } catch { /* waiting for listen */ }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(ready, 'fixture server must start')

    await t.test('compressible responses honor gzip negotiation and conditional requests', async () => {
        const raw = (requestPath, headers = {}) => new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers }, res => {
                const chunks = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
                res.on('error', reject)
            })
            req.on('error', reject)
        })
        const file = '/music/js/local_music.js'
        const plain = await raw(file, { 'Accept-Encoding': 'gzip;q=0, *;q=1' })
        const compressed = await raw(file, { 'Accept-Encoding': 'gzip, deflate' })
        assert.equal(plain.status, 200)
        assert.equal(plain.headers['content-encoding'], undefined)
        assert.equal(compressed.headers['content-encoding'], 'gzip')
        assert.equal(compressed.headers.vary, 'Accept-Encoding')
        assert.ok(compressed.body.length < plain.body.length)
        assert.deepEqual(gunzipSync(compressed.body), plain.body)
        const cached = await raw(file, { 'Accept-Encoding': 'gzip', 'If-None-Match': compressed.headers.etag })
        assert.equal(cached.status, 304)
        assert.equal(cached.headers.vary, 'Accept-Encoding')

        const response = await fetch(`http://127.0.0.1:${port}/api/user/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'alice', password: users[0].password }),
        })
        const session = await response.json()
        assert.ok(session.success)
        const auth = { 'x-user-name': 'alice', 'x-user-token': session.token }
        try {
            const listPlain = await raw('/api/music/custom/list', { ...auth, 'Accept-Encoding': 'identity' })
            const listGzip = await raw('/api/music/custom/list', { ...auth, 'Accept-Encoding': 'gzip' })
            assert.equal(listGzip.status, 200)
            assert.equal(listGzip.headers['content-encoding'], 'gzip')
            assert.equal(listGzip.headers['cache-control'], 'no-cache, no-store, must-revalidate')
            assert.deepEqual(gunzipSync(listGzip.body), listPlain.body)
            assert.equal(JSON.parse(gunzipSync(listGzip.body)).data.length, 5)
        } finally {
            await fetch(`http://127.0.0.1:${port}/api/user/logout`, { method: 'POST', headers: auth })
        }
    })

    let song
    await t.test('library, search, albums, artists and XML expose indexed files', async () => {
        const playlists = await json('getPlaylists')
        const custom = playlists.playlists.playlist.find(list => list.id === 'custom-directory')
        assert.equal(custom.name, '本地音乐')
        assert.equal(custom.songCount, 3)
        const playlist = (await json('getPlaylist', { id: custom.id })).playlist
        assert.equal(playlist.entry.length, 3)
        song = playlist.entry.find(entry => entry.title === 'Fixture & Track')
        assert.ok(song.id.startsWith('localdir_'))
        assert.equal(song.suffix, 'wav')
        assert.equal(song.contentType, 'audio/wav')
        assert.equal(song.size, audio.length)
        assert.equal(song.duration, 10)
        assert.equal((await json('getSong', { id: song.id })).song.title, song.title)
        const albums = (await json('getAlbumList2', { type: 'alphabeticalByName', size: '100' })).albumList2.album
        assert.equal(albums.length, 2)
        const album = (await json('getAlbum', { id: song.albumId })).album
        assert.equal(album.name, 'Fixture Album')
        assert.equal(album.song.length, 2)
        assert.equal(album.artist, 'Fixture Artist')
        const artists = (await json('getArtists')).artists.index.flatMap(index => index.artist)
        assert.equal(artists.length, 1)
        assert.equal(artists[0].songCount, 3)
        assert.equal(artists[0].coverArt, song.id)
        const artist = (await json('getArtist', { id: artists[0].id })).artist
        assert.equal(artist.song.length, 3)
        assert.equal(artist.album.length, 2)
        assert.equal((await json('getMusicDirectory', { id: 'local' })).directory.child.length, 3)
        const search = (await json('search3', { query: 'Fixture', musicFolderId: 'local', songCount: '100' })).searchResult3
        assert.equal(search.song.length, 3)
        assert.equal(search.album.length, 2)
        assert.equal(search.artist.length, 1)
        assert.equal((await json('getRandomSongs', { size: '100' })).randomSongs.song.length, 3)
        const xml = await (await request('getSong', { id: song.id, f: 'xml' })).text()
        assert.match(xml, /title="Fixture &amp; Track"/)
    })

    await t.test('streaming, seeking, HEAD and downloads return the actual file', async () => {
        const full = await request('stream', { id: song.id })
        assert.equal(full.status, 200)
        assert.deepEqual(Buffer.from(await full.arrayBuffer()), audio)
        for (const [range, start, end] of [['bytes=0-31', 0, 31], ['bytes=32-', 32, audio.length - 1],
            ['bytes=-16', audio.length - 16, audio.length - 1], ['bytes=1600-9999', 1600, audio.length - 1]]) {
            const response = await request('stream', { id: song.id }, 'alice', { headers: { Range: range } })
            assert.equal(response.status, 206)
            assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${audio.length}`)
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio.subarray(start, end + 1))
        }
        for (const range of ['bytes=9999-', 'bytes=30-10', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=abc']) {
            const response = await request('stream', { id: song.id }, 'alice', { headers: { Range: range } })
            assert.equal(response.status, 416)
            assert.equal(response.headers.get('content-range'), `bytes */${audio.length}`)
            await response.arrayBuffer()
        }
        const head = await request('stream', { id: song.id }, 'alice', { method: 'HEAD' })
        assert.equal(head.status, 200)
        assert.equal(head.headers.get('content-length'), String(audio.length))
        assert.equal((await head.arrayBuffer()).byteLength, 0)
        const download = await request('download', { id: song.id })
        assert.match(download.headers.get('content-disposition'), /attachment; filename\*=UTF-8''/)
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), audio)
    })

    await t.test('local lyrics and optional covers work without network access', async () => {
        const lyrics = await json('getLyricsBySongId', { id: song.id })
        assert.match(lyrics.lyrics.value, /本地歌词 & lyrics/)
        assert.equal(lyrics.lyricsList.structuredLyrics[0].line[0].start, 1000)
        const cover = await request('getCoverArt', { id: song.coverArt })
        assert.equal(cover.status, 200)
        assert.equal(cover.headers.get('content-type'), 'image/png')
        assert.deepEqual(Buffer.from(await cover.arrayBuffer()), coverImage)
        const albumCover = await request('getCoverArt', { id: song.albumId })
        assert.equal(albumCover.headers.get('content-type'), 'image/png')
        assert.deepEqual(Buffer.from(await albumCover.arrayBuffer()), coverImage)
    })

    await t.test('another user and disabled users cannot reuse IDs or local paths', async () => {
        const bobSongs = (await json('getPlaylist', { id: 'custom-directory' }, 'bob')).playlist.entry
        assert.equal(bobSongs.length, 1)
        assert.notEqual(bobSongs[0].id, song.id, 'same relative path gets a different user ID')
        for (const user of ['bob', 'disabled']) {
            for (const method of ['getSong', 'stream', 'download', 'getCoverArt', 'getLyricsBySongId']) {
                const result = await json(method, { id: song.id }, user)
                assert.equal(result.status, 'failed', `${user} cannot call ${method} with Alice's ID`)
            }
            assert.equal((await json('getAlbum', { id: song.albumId }, user)).status, 'failed')
        }
        const disabled = await json('getPlaylists', {}, 'disabled')
        assert.ok(!disabled.playlists.playlist.some(list => list.id === 'custom-directory'))
        const escapeSong = (await json('getPlaylist', { id: 'custom-directory' }, 'escape')).playlist.entry[0]
        const escape = await request('stream', { id: escapeSong.id }, 'escape')
        assert.equal(escape.status, 404)
        await escape.arrayBuffer()
    })

    await t.test('favoriting a directory song keeps album and artist counts stable', async () => {
        assert.equal((await json('star', { id: song.id })).status, 'ok')
        assert.equal((await json('getStarred2')).starred2.song[0].id, song.id)
        assert.equal((await json('getAlbumList2', { type: 'alphabeticalByName' })).albumList2.album[0].songCount, 2)
        const artists = (await json('getArtists')).artists.index.flatMap(index => index.artist)
        assert.equal(artists[0].songCount, 3)
        assert.equal((await json('unstar', { id: song.id })).status, 'ok')
        assert.equal((await json('getStarred2')).starred2.song.length, 0)
    })

    await t.test('directory playlist cannot be edited or deleted; scan counts are real', async () => {
        assert.equal((await json('updatePlaylist', { playlistId: 'custom-directory', name: 'Renamed' })).status, 'failed')
        assert.equal((await json('deletePlaylist', { id: 'custom-directory' })).status, 'failed')
        assert.equal((await json('getScanStatus')).scanStatus.count, 3)
        assert.equal((await json('getScanStatus', {}, 'disabled')).scanStatus.count, 0)
        assert.ok(fs.existsSync(path.join(aliceRoot, names[0])))
        const scanned = await json('startScan')
        assert.equal(scanned.scanStatus.count, 3)
        assert.equal((await json('getSong', { id: song.id })).status, 'ok', 'rescan keeps path-based song IDs stable')
        const unauthenticated = await fetch(`http://127.0.0.1:${port}/rest/ping.view?f=json`)
        assert.equal((await unauthenticated.json())['subsonic-response'].status, 'failed')
    })

    await t.test('web and Subsonic decode legacy tags and migrate unchanged indexes without touching audio', async () => {
        const bobFile = path.join(bobRoot, names[0])
        const beforeStat = fs.statSync(bobFile)
        const bobSong = (await json('getPlaylist', { id: 'custom-directory' }, 'bob')).playlist.entry[0]
        assert.equal(bobSong.title, '突然好想你')
        assert.equal(bobSong.artist, '五月天')
        assert.equal(bobSong.album, '后青春期的诗')
        assert.equal((await json('getAlbum', { id: bobSong.albumId }, 'bob')).album.name, '后青春期的诗')
        const bobIndex = path.join(bobRoot, 'custom_index.json')
        assert.equal(JSON.parse(fs.readFileSync(bobIndex))[names[0]].name, 'Í»È»ºÃÏëÄã', 'reads do not rewrite the index')

        const login = await fetch(`http://127.0.0.1:${port}/api/user/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'bob', password: users[1].password }),
        })
        const session = await login.json()
        assert.ok(session.success)
        const headers = { 'x-user-name': 'bob', 'x-user-token': session.token }
        try {
            const web = await (await fetch(`http://127.0.0.1:${port}/api/music/custom/list`, { headers })).json()
            assert.equal(web.data[0].name, bobSong.title)
            assert.equal(web.data[0].songInfo.singer, bobSong.artist)
        } finally {
            await fetch(`http://127.0.0.1:${port}/api/user/logout`, { method: 'POST', headers })
        }

        assert.equal((await json('startScan', {}, 'bob')).scanStatus.count, 1)
        const saved = JSON.parse(fs.readFileSync(bobIndex))[names[0]]
        assert.equal(saved.name, bobSong.title)
        assert.equal(saved.singer, bobSong.artist)
        assert.equal(saved.album, bobSong.album)
        assert.equal(saved.id, 'fixture-0')
        assert.equal((await json('getSong', { id: bobSong.id }, 'bob')).song.id, bobSong.id)
        assert.deepEqual(fs.readFileSync(bobFile), audio)
        assert.equal(fs.statSync(bobFile).mtimeMs, beforeStat.mtimeMs)

        // A newly discovered file exercises the native tag reader, not migration.
        const frame = (id, value) => {
            const payload = Buffer.concat([Buffer.from([0]), iconv.encode(value, 'gbk')])
            const header = Buffer.alloc(10)
            header.write(id)
            header.writeUInt32BE(payload.length, 4)
            return Buffer.concat([header, payload])
        }
        const textFrames = Buffer.concat([frame('TIT2', '光辉岁月'), frame('TPE1', 'BEYOND'), frame('TALB', '光辉岁月专辑')])
        const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0])
        for (let i = 0; i < 4; i++) header[9 - i] = (textFrames.length >>> (7 * i)) & 0x7f
        const mp3Frame = Buffer.alloc(417)
        mp3Frame.writeUInt32BE(0xfffb9000)
        const mp3 = Buffer.concat([header, textFrames, ...Array(12).fill(mp3Frame)])
        const newFile = path.join(bobRoot, '新文件 - 光辉岁月.mp3')
        fs.writeFileSync(newFile, mp3)
        assert.equal((await json('startScan', {}, 'bob')).scanStatus.count, 2)
        const discovered = (await json('getPlaylist', { id: 'custom-directory' }, 'bob')).playlist.entry.find(item => item.id !== bobSong.id)
        assert.equal(discovered.title, '光辉岁月')
        assert.equal(discovered.artist, 'BEYOND')
        assert.equal(discovered.album, '光辉岁月专辑')
        assert.deepEqual(fs.readFileSync(newFile), mp3)
        assert.equal((await json('search3', { query: '光辉岁月', musicFolderId: 'local' }, 'bob')).searchResult3.song[0].id, discovered.id)
    })

    await t.test('cover background endpoints enforce permissions and web/Subsonic read the same sidecar', async () => {
        const endpoint = `http://127.0.0.1:${port}/api/music/custom/covers/batch`
        assert.equal((await fetch(endpoint)).status, 401)
        const sessions = []
        const login = async username => {
            const response = await fetch(`http://127.0.0.1:${port}/api/user/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: users.find(user => user.name === username).password }),
            })
            const result = await response.json()
            assert.ok(result.success)
            const headers = { 'x-user-name': username, 'x-user-token': result.token, 'Content-Type': 'application/json' }
            sessions.push(headers)
            return headers
        }
        try {
            const bobHeaders = await login('bob'), writerHeaders = await login('writer')
            assert.equal((await fetch(endpoint, { method: 'POST', headers: bobHeaders, body: '{}' })).status, 403)
            assert.equal((await fetch(endpoint, { method: 'PUT', headers: writerHeaders })).status, 405)
            assert.equal((await fetch(endpoint, { method: 'POST', headers: writerHeaders, body: '{"filenames":null}' })).status, 400)
            const started = await fetch(endpoint, { method: 'POST', headers: writerHeaders, body: JSON.stringify({ filenames: [names[0]] }) })
            assert.equal(started.status, 202)
            let job = (await started.json()).job
            for (let i = 0; i < 100 && ['running', 'cancelling'].includes(job.status); i++) {
                await new Promise(resolve => setTimeout(resolve, 10))
                job = (await (await fetch(endpoint, { headers: writerHeaders })).json()).job
            }
            assert.equal(job.status, 'completed'); assert.equal(job.skipped, 1)
            assert.equal(job.details[0].reason, '已有同名封面文件')
            assert.equal((await (await fetch(endpoint, { headers: bobHeaders })).json()).job, null)
            const web = await fetch(`http://127.0.0.1:${port}/api/music/custom/cover?filename=${encodeURIComponent(names[0])}`, { headers: writerHeaders })
            assert.equal(web.headers.get('content-type'), 'image/png')
            assert.deepEqual(Buffer.from(await web.arrayBuffer()), coverImage)
            const list = await (await fetch(`http://127.0.0.1:${port}/api/music/custom/list`, { headers: writerHeaders })).json()
            const covered = list.data.find(item => item.filename === names[0])
            assert.ok(covered.hasCover); assert.equal(covered.coverType, 'sidecar')
            const originalId = covered.id
            fs.unlinkSync(path.join(aliceRoot, '目录/01_测试 & song.png'))
            const missing = await request('getCoverArt', { id: song.coverArt })
            assert.equal(missing.headers.get('content-type'), 'image/svg+xml')
            await missing.arrayBuffer()
            const removedList = await (await fetch(`http://127.0.0.1:${port}/api/music/custom/list`, { headers: writerHeaders })).json()
            assert.equal(removedList.data.find(item => item.filename === names[0]).hasCover, false)
            fs.writeFileSync(path.join(aliceRoot, '目录/01_测试 & song.png'), coverImage)
            const restored = await request('getCoverArt', { id: song.coverArt })
            assert.equal(restored.headers.get('content-type'), 'image/png')
            assert.deepEqual(Buffer.from(await restored.arrayBuffer()), coverImage)
            const restoredList = await (await fetch(`http://127.0.0.1:${port}/api/music/custom/list`, { headers: writerHeaders })).json()
            assert.equal(restoredList.data.find(item => item.filename === names[0]).coverType, 'sidecar')
            const rescan = await fetch(`http://127.0.0.1:${port}/api/music/custom/sync`, { method: 'POST', headers: writerHeaders })
            assert.ok((await rescan.json()).success)
            const saved = JSON.parse(fs.readFileSync(path.join(aliceRoot, 'custom_index.json')))[names[0]]
            assert.equal(saved.id, originalId); assert.equal(saved.coverType, 'sidecar')
            assert.equal(saved.name, song.title, 'discovering a cover must preserve the existing song metadata')
            assert.deepEqual(fs.readFileSync(path.join(aliceRoot, names[0])), audio)
        } finally {
            for (const headers of sessions) await fetch(`http://127.0.0.1:${port}/api/user/logout`, { method: 'POST', headers })
        }
    })

    await t.test('lyric background endpoints enforce user permissions and expose sidecars to the web player', async () => {
        const endpoint = `http://127.0.0.1:${port}/api/music/custom/lyrics/batch`
        const unauthenticated = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        assert.equal(unauthenticated.status, 401)
        const sessions = []
        const login = async username => {
            const response = await fetch(`http://127.0.0.1:${port}/api/user/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: users.find(user => user.name === username).password }),
            })
            const result = await response.json()
            assert.ok(result.success)
            const headers = { 'x-user-name': username, 'x-user-token': result.token, 'Content-Type': 'application/json' }
            sessions.push(headers)
            return headers
        }
        try {
            const bobHeaders = await login('bob')
            assert.equal((await fetch(endpoint, { method: 'POST', headers: bobHeaders, body: '{}' })).status, 403)
            const writerHeaders = await login('writer')
            assert.equal((await fetch(endpoint, { method: 'POST', headers: writerHeaders, body: '{"filenames":null}' })).status, 400)
            const started = await fetch(endpoint, { method: 'POST', headers: writerHeaders, body: JSON.stringify({ filenames: [names[0]] }) })
            assert.equal(started.status, 202)
            let job = (await started.json()).job
            for (let i = 0; i < 100 && ['running', 'cancelling'].includes(job.status); i++) {
                await new Promise(resolve => setTimeout(resolve, 10))
                job = (await (await fetch(endpoint, { headers: writerHeaders })).json()).job
            }
            assert.equal(job.status, 'completed')
            assert.equal(job.total, 1)
            assert.equal(job.skipped, 1)
            assert.equal(job.details[0].reason, '已有外置歌词')
            assert.equal((await (await fetch(endpoint, { headers: bobHeaders })).json()).job, null)
            const webLyrics = await (await fetch(`http://127.0.0.1:${port}/api/music/custom/embedLyric?filename=${encodeURIComponent(names[0])}`, { headers: writerHeaders })).json()
            assert.equal(webLyrics.source, 'sidecar')
            assert.match(webLyrics.lrc, /本地歌词 & lyrics/)
            assert.deepEqual(fs.readFileSync(path.join(aliceRoot, names[0])), audio)
        } finally {
            for (const headers of sessions) await fetch(`http://127.0.0.1:${port}/api/user/logout`, { method: 'POST', headers })
        }
    })
})
