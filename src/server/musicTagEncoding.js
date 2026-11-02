const iconv = require('iconv-lite')
const { analyse } = require('chardet')
const path = require('node:path')

const fields = ['name', 'singer', 'album']
const encodings = ['UTF-8', 'GB18030', 'Big5', 'EUC-KR', 'Shift_JIS']
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]|\p{Co}/u
const nonLatinLetters = /[^\p{L}]|[\u0000-\u024f]/gu

// Some old ID3 tags contain local code-page bytes labelled as Latin-1. Only
// reconstruct bytes when the string has a mojibake pattern; keep proper Unicode
// and ordinary accented artist names intact.
const legacyBytes = value => {
    if (!value || /[^\u0000-\u00ff]/u.test(value) || !/[\u0080-\u00ff]{2}/u.test(value)) return null
    const highBytes = (value.match(/[\u0080-\u00ff]/gu) || []).length
    const symbols = /[\u0080-\u00bf\u00d7\u00f7]/u.test(value)
    if (!symbols && (highBytes < 4 || !/[\u0080-\u00ff]{4}/u.test(value))) return null
    return Buffer.from(value, 'latin1')
}

const decodeExactly = (bytes, encoding) => {
    const value = iconv.decode(bytes, encoding, { stripBOM: false })
    if (invalidText.test(value) || !iconv.encode(value, encoding).equals(bytes)) {
        // ID3v1 text fields are 30 bytes; old writers can cut a GBK character in
        // half at that boundary. Recover only its valid prefix, marking the loss.
        if (encoding === 'GB18030' && bytes.length === 30 && bytes[29] >= 0x81 && value.endsWith('\ufffd')) {
            const prefix = bytes.subarray(0, -1)
            const text = iconv.decode(prefix, encoding)
            if (!invalidText.test(text) && iconv.encode(text, encoding).equals(prefix)) return text + '…'
        }
        return null
    }
    return value.replace(/^\ufeff/u, '')
}

/**
 * Recover legacy text for display/indexing without modifying the audio file.
 * Detection uses all damaged tags together, with the readable filename as a hint.
 * Ambiguous short Chinese tags prefer GB18030; filename evidence and statistical
 * detection can select Big5, Korean or Japanese instead.
 * @param {{name: string, singer: string, album: string}} tags
 * @param {string} filename
 * @returns {{name: string, singer: string, album: string}}
 */
const decodeMusicTags = (tags, filename) => {
    const damaged = fields.map(field => ({ field, bytes: legacyBytes(tags[field]) })).filter(item => item.bytes)
    if (!damaged.length) return tags

    const sample = Buffer.concat(damaged.flatMap(item => [item.bytes, Buffer.from('\n')]))
    const confidence = new Map(analyse(sample).map(match => [match.name, match.confidence]))
    const hint = path.basename(filename, path.extname(filename)).normalize('NFKC').toLowerCase()
    const hintLetters = new Set(hint.replace(nonLatinLetters, ''))
    const candidates = []

    for (const encoding of encodings) {
        const values = {}
        let decodedCount = 0
        let matched = 0
        let text = ''
        for (const { field, bytes } of damaged) {
            const value = decodeExactly(bytes, encoding)
            if (value === null) continue
            values[field] = value
            decodedCount++
            text += value + '\n'
            const letters = new Set(value.normalize('NFKC').replace(nonLatinLetters, ''))
            for (const char of letters) if (hintLetters.has(char)) matched++
            if (hint.includes(value.normalize('NFKC').trim().toLowerCase())) matched++
        }
        if (!decodedCount) continue

        const han = (text.match(/\p{Script=Han}/gu) || []).length
        const hangul = (text.match(/[\uac00-\ud7a3]/gu) || []).length
        const kana = (text.match(/[\u3040-\u30ff]/gu) || []).length
        const certainty = confidence.get(encoding) || 0
        if (encoding === 'EUC-KR' && (!hangul || hangul / (hangul + han) < 0.8 || (certainty < 60 && !/[\uac00-\ud7a3]/u.test(hint)))) continue
        if (encoding === 'Shift_JIS' && (!kana || (certainty < 60 && !/[\u3040-\u30ff]/u.test(hint)))) continue
        if (encoding !== 'UTF-8' && !/[^\u0000-\u00ff]/u.test(text)) continue

        const score = matched * 4 + decodedCount / damaged.length
            + certainty / 100 + (encoding === 'GB18030' ? 0.2 : 0)
            + (encoding === 'UTF-8' ? 2 : 0)
        candidates.push({ values, score })
    }

    candidates.sort((a, b) => b.score - a.score)
    return candidates.length ? { ...tags, ...candidates[0].values } : tags
}

module.exports = { decodeMusicTags }
