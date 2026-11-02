const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { test } = require('node:test')
const { promisify } = require('node:util')

// vm2 callbacks interfere with Node's test IPC serialization on Node 24.
// Run the fixture in a standalone process and report its exit status as a test.
test('LX custom-source API compatibility', { timeout: 20000 }, async () => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    try {
        await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/user-api-compat.fixture.cjs')], {
            env, timeout: 15000, maxBuffer: 1024 * 1024,
        })
    } catch (error) {
        assert.fail(`${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`)
    }
})
