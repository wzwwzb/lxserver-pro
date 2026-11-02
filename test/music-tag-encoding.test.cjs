const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const fs = require('node:fs')
const iconv = require('iconv-lite')
const builtModule = path.resolve(__dirname, '../server/server/musicTagEncoding.js')
const { decodeMusicTags } = require(fs.existsSync(builtModule) ? builtModule : path.resolve(__dirname, '../src/server/musicTagEncoding.js'))

const misread = (text, encoding) => iconv.encode(text, encoding).toString('latin1')
const tags = (name, singer = '', album = '') => ({ name, singer, album })
const misreadTags = (values, encoding) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, misread(value, encoding)]))

test('restores GBK titles, artists and albums including mixed ASCII text', () => {
    for (const values of [
        tags('突然好想你', '五月天', '后青春期的诗'),
        tags('不分手的恋爱-汪苏泷(silence)', '汪苏泷(silence)', 'MP3下载'),
        tags('My Heart Will Go On（我心永恒）', 'Celine Dion', '泰坦尼克号-百年纪念版'),
        tags('Nothing＇s Gonna Change My Love For You', 'WestLife'),
    ]) {
        assert.deepEqual(decodeMusicTags(misreadTags(values, 'gbk'), values.name + '.mp3'), values)
    }
})

test('uses filename evidence for short ambiguous GBK and Big5 tags', () => {
    for (const [encoding, values, filename] of [
        ['gbk', tags('光辉岁月', 'BEYOND'), 'beyond - 光辉岁月.mp3'],
        ['gbk', tags('Опера 2', 'Vitas'), 'Vitas - Опера 2.mp3'],
        ['big5', tags('海闊天空[粵]', 'BEYOND', 'BEYOND-海闊天空'), 'beyond - 海阔天空 - 粤.mp3'],
        ['big5', tags('Superman', 'V.A', '籃球火音樂聖典'), '篮球火 - super man.mp3'],
    ]) {
        assert.deepEqual(decodeMusicTags(misreadTags(values, encoding), filename), values)
    }
})

test('distinguishes Korean and Japanese tags from Chinese code pages', () => {
    for (const [encoding, values, filename] of [
        ['euc-kr', tags('왜 당신이 궁금할까요', '비비안 & 태사비애', '필승불패 프로젝트 2'), 'vivian、殆死悲爱 - 你为什么好奇.mp3'],
        ['shift_jis', tags('桜の花びらたち', '日本の歌手', '春の思い出'), '歌手 - 桜の花びらたち.mp3'],
    ]) {
        assert.deepEqual(decodeMusicTags(misreadTags(values, encoding), filename), values)
    }
})

test('restores UTF-8 bytes incorrectly read as Latin-1', () => {
    const values = tags('告白气球', '周杰伦', '周杰伦的床边故事')
    assert.deepEqual(decodeMusicTags(misreadTags(values, 'utf8'), '告白气球.mp3'), values)
    assert.equal(decodeMusicTags(tags(misread('Mötley Crüe', 'utf8')), 'Mötley Crüe.mp3').name, 'Mötley Crüe')
})

test('preserves correct Unicode, accented Western names and unknown broken text', () => {
    for (const text of ['正常中文', '다시 너를', 'Опера 2', 'Céline Dion', 'Björk', 'Mötley Crüe', 'Sigur Rós',
        'François Hardy', 'Crème brûlée', 'Édith Piaf', 'Håkan Hellström', 'Ágætis byrjun', 'a\u0081b\u0081', '已损坏�']) {
        const values = tags(text, text, text)
        assert.deepEqual(decodeMusicTags(values, text + '.mp3'), values)
    }
})

test('recovers a truncated ID3v1 field without guessing the missing character', () => {
    const title = '62tt音乐网-发现推荐适合你的音乐'
    const clipped = iconv.encode(title, 'gbk').subarray(0, 30).toString('latin1')
    const result = decodeMusicTags(tags(clipped, misread('站长', 'gbk')), '说爱我.mp3')
    assert.equal(result.name, '62tt音乐网-发现推荐适合你的音…')
    assert.equal(result.singer, '站长')
    assert.deepEqual(decodeMusicTags(result, '说爱我.mp3'), result, 'repeated reads must be idempotent')
})
