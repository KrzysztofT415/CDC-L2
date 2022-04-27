const fs = require('fs')
const { readFile } = require('fs/promises')
const myPrompt = require('prompt')

const ALPHABET_SIZE = 256
const BLOCK_SIZE = 127

const CONFIG = {
    IN_FILE_NAME_PROPERTIES: [
        {
            name: 'inputName',
            description: 'Enter input file name (empty to exit)',
            type: 'string'
        }
    ],
    OUT_FILE_NAME_PROPERTIES: [
        {
            name: 'outputName',
            description: 'Enter output file name (empty to skip)',
            type: 'string'
        }
    ],
    MODE_PROPERTIES: [
        {
            name: 'mode',
            description: 'Enter mode',
            validator: /^((encode)|(decode))$/,
            warning: 'Must be either encode or decode',
            required: true
        }
    ]
}

const pVal = (prob: Array<number>, i: number): number => prob.reduce((sum, val, ind) => sum + val * Number(ind < i), 0)
const pRange = (prob: Array<number>, j: number): [number, number] => {
    const l = pVal(prob, j)
    return [l, l + prob[j]]
}
const pGet = (prob: Array<number>, v: number): number => {
    let i = 0
    let [l, p] = pRange(prob, i)
    while (!(l <= v && v < p && l < p) && i + 1 < prob.length) [l, p] = pRange(prob, ++i)
    return i
}

const binStr2Dec = (bin: string): number => {
    let n = 0
    for (let j = 0; j < bin.length; j++) {
        n += bin[j] == '1' ? 1 : 0
        if (j + 1 < bin.length) n *= 2
    }
    return n
}

const binStr2Float = (bin: string): number => {
    let n = 0
    let t = 0.5
    for (let j = 0; j < bin.length; j++) {
        n += bin[j] == '1' ? t : 0
        t /= 2
    }
    return n
}

const encode = (data: Buffer) => {
    const blocks = Math.ceil(data.length / BLOCK_SIZE)
    const counts = Array(ALPHABET_SIZE).fill(1)

    let content_string = ''
    let average = 0
    for (let t = 0; t < blocks; t++) {
        const block = data.subarray(t * BLOCK_SIZE, Math.min((t + 1) * BLOCK_SIZE, data.length))
        let block_scaling = ''

        let [l, p] = [0, 1]
        const all_count = counts.reduce((sum, val) => sum + val)
        const prob = counts.map(val => val / all_count)
        let prob_all = 1
        for (let i = 0; i < block.length; i++) prob_all *= prob[block[i]]
        let needed_bits = Math.ceil(Math.log2(1 / prob_all)) + 1

        for (let i = 0; i < block.length; i++) {
            const j = block[i]
            counts[j]++

            const d = p - l
            const [dl, dp] = pRange(prob, j)
            p = l + dp * d
            l = l + dl * d

            while (true) {
                if (0 <= l && p < 0.5) {
                    ;[l, p] = [2 * l, 2 * p]
                    block_scaling += '0'
                } else if (0.5 <= l && p < 1) {
                    ;[l, p] = [2 * l - 1, 2 * p - 1]
                    block_scaling += '1'
                } else break
            }
        }
        let z = (l + p) / 2
        let last_bit = z < 0.5 ? '0' : '1'

        if (needed_bits == Infinity) needed_bits = block_scaling.length
        block_scaling = block_scaling.substring(0, needed_bits) + last_bit
        let block_string = block.length.toString(2).padStart(8, '0') + block_scaling
        block_string = block_string.replace(/[1]{5}/g, '1'.repeat(5) + '0')

        const bytes_scaling = Math.ceil(block_string.length / 8)
        average += bytes_scaling + 1

        content_string += block_string.padEnd(bytes_scaling * 8, '0') + '01111110'
    }
    let entropy = 0
    for (let i = 0; i < counts.length; i++) {
        let freq = (counts[i] - 1) / data.length
        if (freq) entropy -= freq * Math.log2(freq)
    }
    average /= blocks

    const bytes = content_string.match(/[01]{8}/g)
    const converted = bytes.map(val => parseInt(val, 2))
    const content = Buffer.from(new Uint8Array(converted).buffer)

    return { content, entropy, average, compression: data.length / content.length }
}

const decode = (data: Buffer) => {
    const counts = Array(ALPHABET_SIZE).fill(1)

    let blocks_strings: string[] = []
    let data_string = ''
    for (let i = 0; i < data.length; i++) data_string += data[i].toString(2).padStart(8, '0')
    blocks_strings = data_string.split('01111110').filter(val => val != '')

    let data_blocks: [number, string][] = []
    let all_size = 0
    for (let i = 0; i < blocks_strings.length; i++) {
        let block = blocks_strings[i]
        block = block.replace(/[1]{5}0/g, '1'.repeat(5))
        let n = binStr2Dec(block.substring(0, 8))

        all_size += n

        data_blocks.push([n, block.substring(8, block.length)])
    }

    const content = Buffer.alloc(all_size)
    let top = -1

    for (let i = 0; i < data_blocks.length; i++) {
        let [n, scaling_string] = data_blocks[i]

        let [l, p] = [0, 1]
        const all_count = counts.reduce((sum, val) => sum + val)
        const prob = counts.map(val => val / all_count)
        const min_step = -Math.floor(Math.log2(Math.min(...prob)))
        let shift = 0

        for (let i = 0; i < n; i++) {
            const z_string = scaling_string.substring(shift, Math.min(shift + min_step, scaling_string.length))
            if (z_string == '') break
            let z = binStr2Float(z_string)

            const d = p - l
            let j = pGet(prob, l + z * d)
            counts[j]++
            content[++top] = j

            const [dl, dp] = pRange(prob, j)

            p = l + dp * d
            l = l + dl * d

            while (true) {
                if (0 <= l && p <= 0.5) {
                    ;[l, p] = [2 * l, 2 * p]
                    shift++
                } else if (0.5 <= l && p <= 1) {
                    ;[l, p] = [2 * l - 1, 2 * p - 1]
                    shift++
                } else break
            }
        }
    }

    return { content }
}

const execute = (data: Buffer, mode: string): Buffer => {
    let processedData: any = undefined
    if (mode == 'encode') {
        processedData = encode(data)
        console.log('CODED: ', processedData.content)
        console.log('> Entropy: ', processedData.entropy)
        console.log('> Avg. coding length: ', processedData.average)
        console.log('> Compression: ', processedData.compression)
    } else if (mode == 'decode') {
        processedData = decode(data)
        console.log('DECODED: ', processedData.content)
    } else {
        console.log('Mode is invalid:', mode)
        return null
    }
    return processedData.content
}

const writeToFile = (outputName: string, processedData: Buffer) => {
    fs.mkdir('./out', err => {
        if (err && err.errno != -17) {
            console.log(err, 'Output path corrupted')
            return
        }

        fs.writeFile('./out/' + outputName, processedData, { encoding: 'utf8', flag: 'w' }, err => {
            if (err) console.log(err, 'Output file corrupted')
        })
    })
}

;(async () => {
    // FAST EXECUTION
    if (process.argv.slice(2).length > 0) {
        console.log(process.argv)

        let [inputName, mode, outputName] = process.argv.slice(2)
        console.log(inputName, mode, outputName)
        let data = await readFile(inputName)
        let processedData = execute(data, mode)
        if (outputName !== undefined) writeToFile(outputName, processedData)
        return
    }

    myPrompt.start()
    readingInput: while (true) {
        // INPUT
        let { inputName } = await myPrompt.get(CONFIG.IN_FILE_NAME_PROPERTIES)
        if (inputName === '') return

        let data: any
        try {
            data = await readFile(inputName)
            console.log('FILE: ', data)
        } catch (exc) {
            console.log(exc, 'File not found')
            continue readingInput
        }

        // MODE & CALCULATIONS
        let { mode } = await myPrompt.get(CONFIG.MODE_PROPERTIES)

        let processedData = execute(data, mode)
        if (processedData == null) continue readingInput

        // OUTPUT
        let { outputName } = await myPrompt.get(CONFIG.OUT_FILE_NAME_PROPERTIES)

        if (outputName !== '') writeToFile(outputName, processedData)
    }
})()
