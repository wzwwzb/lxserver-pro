const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
    createCustomLyricsManager, matchLyricCandidates, localLyricSkipReason,
    usableLyric, readSidecarLyrics, lyricDuration,
} = require(path.resolve(__dirname, '../server/server/customLyrics.js'))

// Original fixture text, not lyrics from a song or an online service.
const fixtureLyric = '[00:01.00]First fixture sentence\n[00:02.00]Second fixture sentence\n[00:03.00]Third fixture sentence\n'
const track = (overrides = {}) => ({ filename: '子目录/测试.mp3', name: '测试歌曲', singer: '测试歌手', interval: '03:00', ...overrides })
const candidate = (song, overrides = {}) => ({ name: song.name, singer: song.singer, interval: song.interval, songmid: 'fixture-id', ...overrides })

const fixture = (t, songs, overrides = {}) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-custom-lyrics-'))
    const root = path.join(tmp, 'music')
    fs.mkdirSync(root)
    for (const song of songs) {
        if (song.filename.includes('..') || path.isAbsolute(song.filename)) continue
        const file = path.join(root, song.filename)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'unchanged original audio bytes')
    }
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
    const saved = []
    const calls = []
    const deps = {
        getRoot: () => root, canWrite: () => true, list: async () => songs,
        reportPath: user => path.join(tmp, 'reports', user + '.json'),
        search: async (source, query) => { calls.push({ source, query }); return songs.map(song => candidate(song)) },
        fetchLyrics: async () => ({ lyric: fixtureLyric }),
        onSaved: (...args) => saved.push(args), sources: ['wy', 'tx'], delayMs: 0, timeoutMs: 50,
        ...overrides,
    }
    return { tmp, root, deps, calls, saved, manager: createCustomLyricsManager(deps) }
}
const finish = async (manager, user = 'alice') => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
        const job = manager.get(user)
        if (job && !['running', 'cancelling'].includes(job.status)) return job
        await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('fixture job did not finish')
}

test('lyric matching requires title, singer, version and duration agreement', () => {
    const local = track({ name: '光輝歲月', singer: 'BEYOND', interval: '04:57' })
    const values = [
        candidate(local, { name: '光辉岁月', singer: 'Beyond', interval: '04:58' }),
        candidate(local, { name: '光辉岁月 (Live)', interval: '04:57' }),
        candidate(local, { singer: '另一歌手', interval: '04:57' }),
        candidate(local, { interval: '05:02' }),
        candidate(local, { name: '其他歌曲' }),
        candidate(local, { interval: '' }),
    ]
    assert.deepEqual(matchLyricCandidates(local, values), [values[0]])
    assert.equal(matchLyricCandidates(track({ name: '02. 童话' }), [candidate(track(), { name: '童话' })]).length, 1)
    assert.equal(matchLyricCandidates(track({ singer: 'G.E.M.邓紫棋' }), [candidate(track(), { singer: '邓紫棋' })]).length, 1)
    assert.equal(matchLyricCandidates(track({ singer: '甲歌手/乙歌手' }), [candidate(track(), { singer: '甲歌手' })]).length, 0)
    assert.equal(lyricDuration('01:02:03'), 3723)
    assert.equal(lyricDuration('03:00bad'), 0)
})

test('unreliable metadata and explicitly instrumental files are skipped automatically', () => {
    assert.match(localLyricSkipReason(track({ hasEmbedLyric: true })), /已有/)
    assert.match(localLyricSkipReason(track({ filename: '纯音乐版.mp3' })), /纯音乐/)
    for (const values of [{ singer: '未知歌手' }, { name: '123456' }, { interval: '' }, { singer: '群星' }, { name: 'www.example.test' }]) {
        assert.match(localLyricSkipReason(track(values)), /缺少/)
    }
})

test('lyric validation rejects placeholders, instrumental markers and credit-only results', () => {
    assert.equal(usableLyric({ lyric: fixtureLyric }), fixtureLyric)
    for (const text of ['', '<html>error</html>', '[00:00.00]纯音乐，请欣赏',
        '[00:00.00]作词：甲\n[00:01.00]作曲：乙\n[00:02.00]编曲：丙', 'one line', 'bad\0text']) {
        assert.equal(usableLyric({ lyric: text }), null)
    }
})

test('downloads a sidecar, records its provenance and preserves audio and song identity', async t => {
    const song = track({ id: 'original-local-id', source: 'custom', songmid: 'original-local-id' })
    const f = fixture(t, [song])
    const audio = path.join(f.root, song.filename)
    const before = fs.readFileSync(audio)
    const beforeStat = fs.statSync(audio)
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.status, 'completed')
    assert.equal(job.downloaded, 1)
    assert.equal(job.processed, 1)
    assert.equal(job.details[0].source, 'wy')
    assert.equal(readSidecarLyrics(f.root, song.filename), fixtureLyric)
    assert.deepEqual(f.saved, [['alice', song.filename, '子目录/测试.lrc']])
    assert.deepEqual(fs.readFileSync(audio), before)
    assert.equal(fs.statSync(audio).mtimeMs, beforeStat.mtimeMs)
    assert.equal(song.id, 'original-local-id')
    assert.equal(song.source, 'custom')
    const onDisk = JSON.parse(fs.readFileSync(f.deps.reportPath('alice')))
    assert.equal(onDisk.downloaded, 1)
    assert.ok(!JSON.stringify(onDisk).includes('First fixture sentence'), 'reports never store lyric text')
    const lyricFile = path.join(f.root, '子目录/测试.lrc')
    const lyricStat = fs.statSync(lyricFile)
    f.manager.start('alice')
    const second = await finish(f.manager)
    assert.equal(second.skipped, 1)
    assert.equal(fs.statSync(lyricFile).mtimeMs, lyricStat.mtimeMs)
    assert.equal(f.calls.length, 1, 'existing sidecars do not cause more searches')
})

test('existing lyrics, embedded lyrics and missing metadata cause no network calls', async t => {
    const songs = [track({ filename: 'existing.mp3' }), track({ filename: 'embedded.mp3', hasEmbedLyric: true }),
        track({ filename: 'unknown.mp3', singer: '未知歌手' }), track({ filename: '纯音乐.mp3' })]
    const f = fixture(t, songs)
    fs.writeFileSync(path.join(f.root, 'existing.lrc'), 'keep the original lyric unchanged')
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.skipped, 4)
    assert.equal(job.failed, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(fs.readFileSync(path.join(f.root, 'existing.lrc'), 'utf8'), 'keep the original lyric unchanged')
})

test('falls back to another source after a search timeout', async t => {
    const song = track()
    const f = fixture(t, [song], { timeoutMs: 10, search: async source => source === 'wy' ? new Promise(() => {}) : [candidate(song)] })
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.downloaded, 1)
    assert.equal(job.details[0].source, 'tx')
})

test('empty lyrics and mismatched recordings are skipped without creating files', async t => {
    const song = track()
    for (const overrides of [
        { search: async () => [candidate(song, { singer: 'wrong artist' })] },
        { fetchLyrics: async () => ({ lyric: '[00:00.00]纯音乐，请欣赏' }) },
    ]) {
        const f = fixture(t, [song], overrides)
        f.manager.start('alice')
        const job = await finish(f.manager)
        assert.equal(job.skipped, 1)
        assert.ok(!fs.existsSync(path.join(f.root, '子目录/测试.lrc')))
    }
})

test('temporarily unavailable sources have a circuit breaker', async t => {
    const songs = Array.from({ length: 5 }, (_, i) => track({ filename: `${i}.mp3`, name: `测试歌曲${i}` }))
    let attempts = 0
    const f = fixture(t, songs, { sources: ['wy'], search: async () => { attempts++; throw new Error('network error') } })
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.skipped, 5)
    assert.equal(attempts, 3)
})

test('duplicate starts reuse a job and cancelling during lookup writes nothing', async t => {
    const song = track()
    let release
    let entered
    const searching = new Promise(resolve => { entered = resolve })
    const f = fixture(t, [song], { search: async () => { entered(); return new Promise(resolve => { release = resolve }) } })
    const first = f.manager.start('alice')
    await searching
    assert.equal(f.manager.start('alice').id, first.id)
    assert.equal(f.manager.get('bob'), null)
    assert.equal(f.manager.cancel('bob', first.id), false)
    assert.equal(f.manager.cancel('alice', first.id), true)
    release([candidate(song)])
    const job = await finish(f.manager)
    assert.equal(job.status, 'cancelled')
    assert.equal(job.downloaded, 0)
    assert.ok(!fs.existsSync(path.join(f.root, '子目录/测试.lrc')))
})

test('path traversal, audio symlinks and sidecar symlinks cannot reach outside the root', async t => {
    const songs = [track({ filename: '../outside.mp3' }), track({ filename: 'escape.mp3' }), track({ filename: 'sidecar.mp3' })]
    const f = fixture(t, songs)
    const outside = path.join(f.tmp, 'outside.mp3')
    const outsideLyric = path.join(f.tmp, 'private.lrc')
    fs.writeFileSync(outside, 'private audio')
    fs.writeFileSync(outsideLyric, 'private lyric')
    fs.unlinkSync(path.join(f.root, 'escape.mp3'))
    fs.symlinkSync(outside, path.join(f.root, 'escape.mp3'))
    fs.symlinkSync(outsideLyric, path.join(f.root, 'sidecar.lrc'))
    assert.equal(readSidecarLyrics(f.root, 'sidecar.mp3'), '')
    f.manager.start('alice')
    const job = await finish(f.manager)
    assert.equal(job.failed, 2)
    assert.equal(job.skipped, 1)
    assert.equal(f.calls.length, 0)
    assert.equal(fs.readFileSync(outsideLyric, 'utf8'), 'private lyric')
    assert.ok(!fs.existsSync(path.join(f.tmp, 'outside.lrc')))
})

test('rechecks changed directory configuration and permissions before writing', async t => {
    for (const revokePermission of [true, false]) {
        const song = track()
        let allowed = true
        let currentRoot
        const f = fixture(t, [song], {
            getRoot: () => currentRoot,
            canWrite: () => allowed,
            search: async () => {
                if (revokePermission) allowed = false
                else currentRoot = os.tmpdir()
                return [candidate(song)]
            },
        })
        currentRoot = f.root
        f.manager.start('alice')
        const job = await finish(f.manager)
        assert.equal(job.status, 'cancelled')
        assert.equal(job.downloaded, 0)
        assert.ok(!fs.existsSync(path.join(f.root, '子目录/测试.lrc')))
    }
})

test('denies missing write permission and reports interrupted jobs after restart', async t => {
    const f = fixture(t, [track()], { canWrite: () => false })
    assert.throws(() => f.manager.start('alice'), /未允许/)
    fs.mkdirSync(path.dirname(f.deps.reportPath('alice')), { recursive: true })
    fs.writeFileSync(f.deps.reportPath('alice'), JSON.stringify({ id: 'old-job', status: 'running', details: [] }))
    const restarted = createCustomLyricsManager(f.deps)
    assert.equal(restarted.get('alice').status, 'interrupted')
})
