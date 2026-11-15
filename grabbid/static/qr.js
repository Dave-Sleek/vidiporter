(() => {
  "use strict";

  // ISO/IEC 18004 Error Correction Level M parameters for Versions 1..20: [eccPerBlock, numBlocks]
  const ECC_M_TABLE = [
    null,
    [10, 1],
    [16, 1],
    [26, 1],
    [18, 2],
    [24, 2],
    [16, 4],
    [18, 4],
    [22, 4],
    [22, 5],
    [26, 5],
    [30, 5],
    [22, 8],
    [22, 9],
    [24, 9],
    [24, 10],
    [28, 10],
    [28, 11],
    [26, 13],
    [26, 14],
    [26, 16],
  ];

  // ECC format bit for Level M is 0b00
  const ECC_FORMAT_BITS = 0;

  function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) {
        result -= 36;
      }
    }
    return result;
  }

  function getNumDataCodewords(ver) {
    const [eccPerBlock, numBlocks] = ECC_M_TABLE[ver];
    return Math.floor(getNumRawDataModules(ver) / 8) - eccPerBlock * numBlocks;
  }

  function getAlignmentPatternPositions(ver) {
    if (ver === 1) return [];
    const size = ver * 4 + 17;
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  function reedSolomonMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function reedSolomonDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = reedSolomonMultiply(result[j], root);
        if (j + 1 < degree) {
          result[j] ^= result[j + 1];
        }
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonRemainder(data, divisor) {
    const result = new Uint8Array(divisor.length);
    for (const b of data) {
      const factor = b ^ result[0];
      result.copyWithin(0, 1);
      result[result.length - 1] = 0;
      for (let i = 0; i < divisor.length; i++) {
        result[i] ^= reedSolomonMultiply(divisor[i], factor);
      }
    }
    return result;
  }

  function utf8ToBytes(str) {
    if (typeof TextEncoder === "function") {
      return Array.from(new TextEncoder().encode(str));
    }
    const encoded = unescape(encodeURIComponent(str));
    const bytes = new Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) {
      bytes[i] = encoded.charCodeAt(i);
    }
    return bytes;
  }

  function appendBits(val, len, bitBuf) {
    for (let i = len - 1; i >= 0; i--) {
      bitBuf.push((val >>> i) & 1);
    }
  }

  function encodeData(bytes) {
    let version = 1;
    let charCountBits = 8;
    while (version <= 20) {
      charCountBits = version <= 9 ? 8 : 16;
      const capBits = getNumDataCodewords(version) * 8;
      const neededBits = 4 + charCountBits + bytes.length * 8;
      if (neededBits <= capBits) break;
      version++;
    }
    if (version > 20) {
      throw new Error("URL is too long for QR code encoding.");
    }

    const dataCapBytes = getNumDataCodewords(version);
    const bits = [];
    // Byte mode indicator: 0100
    appendBits(0b0100, 4, bits);
    appendBits(bytes.length, charCountBits, bits);
    for (const b of bytes) {
      appendBits(b, 8, bits);
    }

    const capBits = dataCapBytes * 8;
    appendBits(0, Math.min(4, capBits - bits.length), bits);
    while (bits.length % 8 !== 0) {
      bits.push(0);
    }
    for (let padByte = 0xec; bits.length < capBits; padByte ^= 0xec ^ 0x11) {
      appendBits(padByte, 8, bits);
    }

    const dataCodewords = new Uint8Array(dataCapBytes);
    for (let i = 0; i < bits.length; i++) {
      dataCodewords[i >>> 3] |= bits[i] << (7 - (i & 7));
    }

    // Split into blocks and compute ECC
    const [eccLen, numBlocks] = ECC_M_TABLE[version];
    const totalCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const shortBlockLen = Math.floor(totalCodewords / numBlocks);
    const numShortBlocks = numBlocks - (totalCodewords % numBlocks);
    const divisor = reedSolomonDivisor(eccLen);

    const blocks = [];
    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const datLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
      const dat = dataCodewords.subarray(offset, offset + datLen);
      offset += datLen;
      const ecc = reedSolomonRemainder(dat, divisor);
      const block = new Uint8Array(datLen + eccLen);
      block.set(dat, 0);
      block.set(ecc, datLen);
      blocks.push(block);
    }

    const result = [];
    const maxDataLen = shortBlockLen - eccLen + 1;
    for (let i = 0; i < maxDataLen; i++) {
      for (let j = 0; j < numBlocks; j++) {
        const blockDataLen = shortBlockLen - eccLen + (j < numShortBlocks ? 0 : 1);
        if (i < blockDataLen) {
          result.push(blocks[j][i]);
        }
      }
    }
    for (let i = 0; i < eccLen; i++) {
      for (let j = 0; j < numBlocks; j++) {
        const blockDataLen = shortBlockLen - eccLen + (j < numShortBlocks ? 0 : 1);
        result.push(blocks[j][blockDataLen + i]);
      }
    }

    return { version, codewords: result };
  }

  function createMatrix(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

    function setFunctionModule(x, y, isDark) {
      modules[y][x] = isDark ? 1 : 0;
      isFunction[y][x] = 1;
    }

    // Timing patterns
    for (let i = 0; i < size; i++) {
      setFunctionModule(6, i, i % 2 === 0);
      setFunctionModule(i, 6, i % 2 === 0);
    }

    // Finder patterns + separators
    function drawFinder(cx, cy) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunctionModule(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // Alignment patterns
    const alignPos = getAlignmentPatternPositions(version);
    for (let i = 0; i < alignPos.length; i++) {
      for (let j = 0; j < alignPos.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === alignPos.length - 1) ||
          (i === alignPos.length - 1 && j === 0)
        ) {
          continue;
        }
        const cx = alignPos[i];
        const cy = alignPos[j];
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // Reserve format info + dark module
    for (let i = 0; i <= 5; i++) {
      setFunctionModule(8, i, false);
      setFunctionModule(8, size - 1 - i, false);
      setFunctionModule(i, 8, false);
      setFunctionModule(size - 1 - i, 8, false);
    }
    setFunctionModule(8, 6, true);
    setFunctionModule(8, 7, false);
    setFunctionModule(8, 8, false);
    setFunctionModule(7, 8, false);
    setFunctionModule(size - 8, 8, false);
    setFunctionModule(size - 7, 8, false);
    setFunctionModule(8, size - 7, false);
    setFunctionModule(8, size - 8, true); // Dark module

    // Reserve version info for V7+
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) {
        rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      }
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunctionModule(a, b, bit);
        setFunctionModule(b, a, bit);
      }
    }

    return { size, modules, isFunction, setFunctionModule };
  }

  function drawFormatBits(matrix, mask) {
    const { size, setFunctionModule } = matrix;
    const data = (ECC_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412;

    for (let i = 0; i <= 5; i++) {
      setFunctionModule(8, i, ((bits >>> i) & 1) !== 0);
    }
    setFunctionModule(8, 7, ((bits >>> 6) & 1) !== 0);
    setFunctionModule(8, 8, ((bits >>> 7) & 1) !== 0);
    setFunctionModule(7, 8, ((bits >>> 8) & 1) !== 0);
    for (let i = 9; i < 15; i++) {
      setFunctionModule(14 - i, 8, ((bits >>> i) & 1) !== 0);
    }

    for (let i = 0; i < 8; i++) {
      setFunctionModule(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
    }
    for (let i = 8; i < 15; i++) {
      setFunctionModule(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
    }
    setFunctionModule(8, size - 8, true);
  }

  function placeCodewords(matrix, codewords) {
    const { size, modules, isFunction } = matrix;
    let i = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < totalBits) {
            const bit = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            modules[y][x] = bit ? 1 : 0;
            i++;
          }
        }
      }
    }
  }

  function applyMask(matrix, mask) {
    const { size, modules, isFunction } = matrix;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunction[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) modules[y][x] ^= 1;
      }
    }
  }

  function calcPenalty(matrix) {
    const { size, modules } = matrix;
    let penalty = 0;

    // Rule 1 & 3 (rows & cols)
    function countRunScore(line) {
      let score = 0;
      let runColor = -1;
      let runLen = 0;
      const hist = [0, 0, 0, 0, 0, 0, 0];
      function pushHist(len) {
        hist.pop();
        hist.unshift(len);
      }
      function matchesFinder() {
        const n = hist[1];
        return n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n &&
          ((hist[0] >= n * 4 && hist[6] >= 0) || (hist[6] >= n * 4 && hist[0] >= 0)) &&
          ((runColor === 0 && hist[0] >= n * 4) || (runColor === 1 && hist[6] >= n * 4));
      }
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score += 1;
        } else {
          if (runLen > 0) {
            pushHist(runLen);
            if (runColor === 0 && hist[1] > 0 && hist[2] === hist[1] && hist[3] === hist[1] * 3 && hist[4] === hist[1] && hist[5] === hist[1]) {
              if (hist[0] >= hist[1] * 4 || hist[6] >= hist[1] * 4) score += 40;
            }
          }
          runColor = c;
          runLen = 1;
        }
      }
      if (runLen > 0) {
        pushHist(runLen);
        if (runColor === 0 && hist[1] > 0 && hist[2] === hist[1] && hist[3] === hist[1] * 3 && hist[4] === hist[1] && hist[5] === hist[1]) {
          if (hist[0] >= hist[1] * 4 || hist[6] >= hist[1] * 4) score += 40;
        }
      }
      void matchesFinder;
      return score;
    }

    for (let y = 0; y < size; y++) {
      penalty += countRunScore(modules[y]);
    }
    const col = new Uint8Array(size);
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) col[y] = modules[y][x];
      penalty += countRunScore(col);
    }

    // Rule 2: 2x2 blocks
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          penalty += 3;
        }
      }
    }

    // Rule 4: Dark module ratio
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        dark += modules[y][x];
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    if (k > 0) penalty += k * 10;

    return penalty;
  }

  function generateMatrix(text) {
    const bytes = utf8ToBytes(text);
    const { version, codewords } = encodeData(bytes);
    const matrix = createMatrix(version);
    placeCodewords(matrix, codewords);

    let bestMask = 0;
    let minPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(matrix, mask);
      drawFormatBits(matrix, mask);
      const p = calcPenalty(matrix);
      if (p < minPenalty) {
        minPenalty = p;
        bestMask = mask;
      }
      applyMask(matrix, mask);
    }

    applyMask(matrix, bestMask);
    drawFormatBits(matrix, bestMask);
    return { size: matrix.size, modules: matrix.modules };
  }

  function toSvgString(text, quietZone = 3) {
    const { size, modules } = generateMatrix(text);
    const total = size + quietZone * 2;
    const parts = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) {
          parts.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code for mobile video download"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${parts.join("")}" fill="#0c0d12"/></svg>`;
  }

  window.VidiporterQR = {
    generateMatrix,
    toSvgString,
  };
})();
