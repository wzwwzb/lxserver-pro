const zlib = require('node:zlib')

// A real, original solid-colour PNG. It can be decoded by browsers and image tools.
const crc32 = data => {
    let crc = 0xffffffff
    for (const byte of data) {
        crc ^= byte
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, checksum])
}
exports.coverPng = (width = 128, height = 128) => {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
    header[8] = 8; header[9] = 2
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x55)])
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}
