function splitPromptLines(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized) return [];
  return normalized.split('\n');
}

export function buildLineDiff(leftText = '', rightText = '') {
  const left = splitPromptLines(leftText);
  const right = splitPromptLines(rightText);
  const rows = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      rows[i][j] = left[i] === right[j]
        ? rows[i + 1][j + 1] + 1
        : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  let leftLine = 1;
  let rightLine = 1;

  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      ops.push({ type: 'equal', left: left[i], right: right[j], leftLine, rightLine });
      i += 1;
      j += 1;
      leftLine += 1;
      rightLine += 1;
    } else if (j >= right.length || (i < left.length && rows[i + 1][j] >= rows[i][j + 1])) {
      ops.push({ type: 'removed', left: left[i], right: '', leftLine, rightLine: null });
      i += 1;
      leftLine += 1;
    } else {
      ops.push({ type: 'added', left: '', right: right[j], leftLine: null, rightLine });
      j += 1;
      rightLine += 1;
    }
  }

  const paired = [];
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op.type === 'equal') {
      paired.push(op);
      continue;
    }

    const removed = [];
    const added = [];
    while (index < ops.length && ops[index].type !== 'equal') {
      if (ops[index].type === 'removed') removed.push(ops[index]);
      if (ops[index].type === 'added') added.push(ops[index]);
      index += 1;
    }
    index -= 1;

    const max = Math.max(removed.length, added.length);
    for (let offset = 0; offset < max; offset += 1) {
      const leftOp = removed[offset];
      const rightOp = added[offset];
      paired.push({
        type: leftOp && rightOp ? 'changed' : leftOp ? 'removed' : 'added',
        left: leftOp?.left || '',
        right: rightOp?.right || '',
        leftLine: leftOp?.leftLine || null,
        rightLine: rightOp?.rightLine || null,
      });
    }
  }

  return paired;
}
