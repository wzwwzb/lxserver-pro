const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { coverPng } = require('./fixtures/cover-image.cjs')
const {
    createCustomCoversManager, matchCoverCandidates, inspectCoverImage,
    allowedCoverUrl, downloadCoverImage, findSidecarCover, readSidecarCover,
} = require(path.resolve(__dirname, '../server/server/customCovers.js'))

const image = coverPng()
const track = (overrides = {}) => ({ filename: '子目录/歌曲.mp3', name: '测试歌曲', singer: '测试歌手', album: '测试专辑', interval: '03:00', ...overrides })
const candidate = (song, overrides = {}) => ({ ...song, albumName: song.album, songmid: 'online-fixture-id', img: 'https://p1.music.126.net/fixture.jpg', ...overrides })
const fixture = (t, songs, overrides = {}) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-custom-covers-'))
    const root = path.join(tmp, 'music')
    fs.mkdirSync(root)
    for (const song of songs) {
        if (song.filename.includes('..') || path.isAbsolute(song.filename)) continue
        const file = path.join(root, song.filename)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'original audio must stay unchanged')
    }
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const saved = [], calls = []
    const deps = {
        getRoot: () => root, canWrite: () => true, list: async () => songs, hasCover: () => false,
        reportPath: user => path.join(tmp, 'reports', user + '.json'),
        search: async (source, query) => { calls.push({ source, query }); return songs.map(song => candidate(song)) },
        fetchCover: async () => image, onSaved: (...args) => saved.push(args),
        sources: ['wy', 'tx'], delayMs: 0, timeoutMs: 100, ...overrides,
    }
    return { tmp, root, deps, calls, saved, manager: createCustomCoversManager(deps) }
}
const finish = async (manager, user = 'alice') => {
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
        const job = manager.get(user)
        if (job && !['running', 'cancelling'].includes(job.status)) return job
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('cover fixture job did not finish')
}

test('cover matching checks recording and album, includes instrumentals and skips ambiguous albums', () => {
    const song = track({ name: '测试歌曲 (Instrumental)' })
    const good = candidate(song)
    assert.deepEqual(matchCoverCandidates(song, [good,
        candidate(song, { albumName: '另一专辑', album: '另一专辑' }),
        candidate(song, { singer: '另一歌手' }), candidate(song, { interval: '03:03' }),
        candidate(song, { name: '测试歌曲 (Live)' }), candidate(song, { albumName: '', album: '' }),
    ]), [good])
    const noAlbum = track({ album: '' })
    const first = candidate(noAlbum, { albumName: '首发专辑' })
    const second = candidate(noAlbum, { albumName: '精选专辑' })
    assert.deepEqual(matchCoverCandidates(noAlbum, [first, second]), [])
    assert.deepEqual(matchCoverCandidates(noAlbum, [first, { ...first, songmid: 'duplicate' }]), [first, { ...first, songmid: 'duplicate' }])
    assert.deepEqual(matchCoverCandidates(track({ album: 'Unknown Album' }), [first]), [first])
})

test('image inspection rejects HTML, empty, oversized and truncated images', () => {
    assert.deepEqual(inspectCoverImage(image), { mime: 'image/png', ext: '.png', width: 128, height: 128 })
    for (const data of [Buffer.alloc(0), Buffer.from('<html>service error</html>'), image.subarray(0, 40), Buffer.alloc(8 * 1024 * 1024 + 1)]) {
        assert.equal(inspectCoverImage(data), null)
    }
    const enormous = Buffer.from(image)
    enormous.writeUInt32BE(20000, 16)
    assert.equal(inspectCoverImage(enormous), null)
})

test('creates a same-name image without changing audio, lyrics or identity and reruns idempotently', async t => {
    const song = track({ id: 'original-id', source: 'custom', songmid: 'original-id' })
    const f = fixture(t, [song])
    const audio = path.join(f.root, song.filename)
    const stat = fs.statSync(audio)
    fs.writeFileSync(path.join(f.root, '子目录/歌曲.lrc'), 'existing lyrics')
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.downloaded, 1)
    assert.equal(job.failed, 0)
    assert.equal(job.details[0].source, 'wy')
    assert.equal(job.details[0].coverFilename, '子目录/歌曲.png', 'extension follows the actual image data')
    assert.deepEqual(readSidecarCover(f.root, song.filename).data, image)
    assert.deepEqual(f.saved, [['alice', song.filename, '子目录/歌曲.png']])
    assert.equal(fs.readFileSync(audio, 'utf8'), 'original audio must stay unchanged')
    assert.equal(fs.statSync(audio).mtimeMs, stat.mtimeMs)
    assert.equal(fs.readFileSync(path.join(f.root, '子目录/歌曲.lrc'), 'utf8'), 'existing lyrics')
    assert.equal(song.id, 'original-id'); assert.equal(song.source, 'custom'); assert.equal(song.songmid, 'original-id')
    const file = findSidecarCover(f.root, song.filename)
    f.manager.start('alice')
    assert.equal((await finish(f.manager)).skipped, 1)
    assert.equal(fs.statSync(file.file).mtimeMs, file.mtime)
    assert.equal(f.calls.length, 1)
    assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(f.deps.reportPath('alice')))).includes('"data"'))
})

test('existing images of any supported extension and embedded covers are preserved; instrumentals are downloaded', async t => {
    const songs = [track({ filename: 'existing.mp3' }), track({ filename: 'embedded.mp3' }),
        track({ filename: 'invalid.mp3' }), track({ filename: 'unknown.mp3', singer: '未知歌手' }),
        track({ filename: '纯音乐.mp3', name: '测试歌曲 (Instrumental)' })]
    const f = fixture(t, songs, { hasCover: (user, filename) => filename === 'embedded.mp3' })
    fs.writeFileSync(path.join(f.root, 'existing.JPEG'), image)
    fs.writeFileSync(path.join(f.root, 'invalid.jpg'), 'keep even an invalid existing image')
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.skipped, 4); assert.equal(job.downloaded, 1)
    assert.equal(f.calls.length, 1)
    assert.equal(fs.readFileSync(path.join(f.root, 'invalid.jpg'), 'utf8'), 'keep even an invalid existing image')
    assert.ok(fs.existsSync(path.join(f.root, '纯音乐.png')))
})

test('fallback works after a search timeout or invalid downloaded image', async t => {
    const song = track()
    for (const badSearch of [true, false]) {
        const f = fixture(t, [song], {
            timeoutMs: 10,
            search: async source => source === 'wy' && badSearch ? new Promise(() => {}) : [candidate(song)],
            fetchCover: async source => source === 'wy' ? Buffer.from('<html>bad image</html>') : image,
        })
        f.manager.start('alice')
        const job = await finish(f.manager)
        assert.equal(job.downloaded, 1); assert.equal(job.details[0].source, 'tx')
    }
})

test('mismatched recordings and unavailable services are automatically skipped', async t => {
    const songs = Array.from({ length: 5 }, (_, i) => track({ filename: `${i}.mp3` }))
    let attempts = 0
    const f = fixture(t, songs, { sources: ['wy'], search: async () => { attempts++; throw new Error('unavailable') } })
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.skipped, 5); assert.equal(job.failed, 0); assert.equal(attempts, 3)
    const unmatched = fixture(t, [track()], { search: async () => [candidate(track(), { singer: 'wrong artist' })] })
    unmatched.manager.start('alice')
    assert.equal((await finish(unmatched.manager)).skipped, 1)
    assert.equal(readSidecarCover(unmatched.root, track().filename), null)
})

test('traversal, audio symlinks and external image symlinks cannot expose or overwrite files', async t => {
    const songs = [track({ filename: '../outside.mp3' }), track({ filename: 'escape.mp3' }), track({ filename: 'sidecar.mp3' })]
    const f = fixture(t, songs)
    const outside = path.join(f.tmp, 'outside.mp3'), privateImage = path.join(f.tmp, 'private.png')
    fs.writeFileSync(outside, 'private audio'); fs.writeFileSync(privateImage, image)
    fs.unlinkSync(path.join(f.root, 'escape.mp3'))
    fs.symlinkSync(outside, path.join(f.root, 'escape.mp3'))
    fs.symlinkSync(privateImage, path.join(f.root, 'sidecar.png'))
    assert.equal(readSidecarCover(f.root, 'sidecar.mp3'), null)
    assert.equal(readSidecarCover(f.root, '../outside.mp3'), null)
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.failed, 2); assert.equal(job.skipped, 1); assert.equal(f.calls.length, 0)
    assert.deepEqual(fs.readFileSync(privateImage), image)
    assert.ok(!fs.existsSync(path.join(f.tmp, 'outside.png')))
})

test('duplicate starts reuse the job and cancellation while fetching does not write an image', async t => {
    let release, entered
    const fetching = new Promise(resolve => { entered = resolve })
    const f = fixture(t, [track()], { fetchCover: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
    const job = f.manager.start('alice')
    await fetching
    assert.equal(f.manager.start('alice').id, job.id)
    assert.equal(f.manager.get('bob'), null)
    assert.equal(f.manager.cancel('bob', job.id), false)
    assert.ok(f.manager.cancel('alice', job.id))
    release(image)
    assert.equal((await finish(f.manager)).status, 'cancelled')
    assert.equal(findSidecarCover(f.root, track().filename), null)
})

test('permissions, root changes, changed audio and newly appearing covers are rechecked before writing', async t => {
    for (const mode of ['permission', 'root', 'audio', 'cover']) {
        let allowed = true, configuredRoot
        const song = track()
        const f = fixture(t, [song], {
            getRoot: () => configuredRoot, canWrite: () => allowed,
            fetchCover: async () => {
                if (mode === 'permission') allowed = false
                if (mode === 'root') configuredRoot = os.tmpdir()
                if (mode === 'audio') fs.appendFileSync(path.join(f.root, song.filename), ' changed')
                if (mode === 'cover') fs.writeFileSync(path.join(f.root, '子目录/歌曲.jpg'), 'new user cover')
                return image
            },
        })
        configuredRoot = f.root
        f.manager.start('alice')
        const job = await finish(f.manager)
        assert.equal(job.downloaded, 0)
        assert.equal(job.status, ['permission', 'root'].includes(mode) ? 'cancelled' : 'completed')
        assert.ok(!fs.existsSync(path.join(f.root, '子目录/歌曲.png')))
        if (mode === 'cover') assert.equal(fs.readFileSync(path.join(f.root, '子目录/歌曲.jpg'), 'utf8'), 'new user cover')
    }
})

test('denies invalid starts and reports restart interruption without resuming silently', t => {
    const f = fixture(t, [track()])
    for (const input of [null, 12, [null], Array(10001).fill('song.mp3')]) assert.throws(() => f.manager.start('alice', input), /无效/)
    const denied = createCustomCoversManager({ ...f.deps, canWrite: () => false })
    assert.throws(() => denied.start('alice'), /未允许/)
    fs.mkdirSync(path.dirname(f.deps.reportPath('alice')), { recursive: true })
    fs.writeFileSync(f.deps.reportPath('alice'), JSON.stringify({ id: 'old-job', status: 'running', details: [] }))
    assert.equal(createCustomCoversManager(f.deps).get('alice').status, 'interrupted')
})

test('downloader enforces CDN hosts and bounds redirects, size and total response time', async t => {
    assert.ok(allowedCoverUrl('https://p1.music.126.net/image.jpg'))
    assert.ok(allowedCoverUrl('https://y.gtimg.cn/music/image.jpg'))
    for (const address of ['file:///etc/passwd', 'http://127.0.0.1/a', 'http://169.254.169.254/a',
        'https://p1.music.126.net.evil.test/a', 'https://user:pass@p1.music.126.net/a', 'https://y.gtimg.cn:1234/a']) {
        assert.equal(allowedCoverUrl(address), false)
        await assert.rejects(downloadCoverImage(address))
    }
    const server = http.createServer((req, res) => {
        if (req.url === '/redirect') { res.writeHead(302, { Location: '/image' }); res.end(); return }
        if (req.url === '/blocked') { res.writeHead(302, { Location: 'http://127.0.0.2/private' }); res.end(); return }
        if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return }
        if (req.url === '/html') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end('<html>upstream error</html>'); return }
        if (req.url === '/large') { res.writeHead(200, { 'Content-Length': 9999999 }); res.end(); return }
        if (req.url === '/slow') { res.writeHead(200); res.write(image.subarray(0, 20)); return }
        if (req.url === '/error') { res.writeHead(503); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(image)
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
    const base = `http://127.0.0.1:${server.address().port}`
    const options = { allowUrl: value => value.startsWith(base + '/'), timeoutMs: 500 }
    assert.deepEqual(await downloadCoverImage(base + '/redirect', options), image)
    for (const route of ['/blocked', '/loop', '/html', '/large', '/error']) await assert.rejects(downloadCoverImage(base + route, options))
    await assert.rejects(downloadCoverImage(base + '/image', { ...options, maxBytes: 64 }))
    await assert.rejects(downloadCoverImage(base + '/slow', { ...options, timeoutMs: 25 }))
})
