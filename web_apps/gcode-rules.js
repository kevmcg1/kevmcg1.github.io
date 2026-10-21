// ============================================================
// G-CODE CONVERSION LIBRARY
// gcode-rules.js — all shortcuts, NL rules, G/M codes, and
// converter logic. Exposes window.GcodeConverter.
// To add a new phrase: add an entry to SHORTCUTS or NL_RULES,
// then add a matching entry in NL_SUGGESTIONS for autocomplete.
// ============================================================
(function () {

  // ----------------------------------------------------------
  // NUMBER / COORD FORMATTING
  // ----------------------------------------------------------

  function fmtNum(numStr) {
    const n = parseFloat(numStr);
    if (isNaN(n)) return numStr;
    if (!isFinite(n) || Math.abs(n) >= 1e21) return numStr;   // too big to format: keep exactly what was typed (never 1e+21 notation)
    if (Number.isInteger(n)) return n + '.';
    let s = Math.abs(n) < 1e-6 ? n.toFixed(12) : n.toString();   // (toString would give 1e-7 notation)
    if (/^-?0\.0*$/.test(s)) return '0.';
    s = s.replace(/(\.\d*[1-9])0+$/, '$1');
    if (s.endsWith('.')) return s;
    // Strip leading zero: 0.5 → .5, -0.5 → -.5
    s = s.replace(/^(-?)0\./, '$1.');
    return s;
  }

  function formatCoords(str) {
    return str.replace(/([XYZABCIJKRQPUVW])(-?\d+\.?\d*)/gi,
      (_, axis, val) => axis.toUpperCase() + fmtNum(val));
  }

  function parseCoords(str) {
    return formatCoords(str.trim().toUpperCase().replace(/\s+/g, ' ').replace(/([\d.])([A-Z])/g, '$1 $2'));
  }

  function applyUnitFormat(str, currentUnits) {
    if (!currentUnits) return str;
    return formatCoords(str);
  }

  // ----------------------------------------------------------
  // MACHINE MODE  (mill or lathe, never both; multiaxis only exists in mill mode and is off by default)
  // Every shortcut, phrase, suggestion and code below carries a machine tag (m: 'mill' | 'lathe' | 'both'; multi: true = needs
  // multiaxis). Only the ones that belong to the chosen machine are recognized, suggested and listed. Axis letters are limited
  // the same way: a mill knows X Y Z (and A B C with multiaxis), a lathe knows X Z U W.
  // ----------------------------------------------------------

  const MACHINE = { type: 'mill', multi: false };
  const AXIS_WORDS = 'XYZABCUVWIJK';
  function allowedAxisLetters() {
    if (MACHINE.type === 'lathe') return 'XZUWIK';
    return 'XYZIJK' + (MACHINE.multi ? 'ABC' : '');
  }
  function setMachine(type, multi) {
    MACHINE.type = type === 'lathe' ? 'lathe' : 'mill';
    MACHINE.multi = MACHINE.type === 'mill' && !!multi;
    return getMachine();
  }
  function getMachine() { return { type: MACHINE.type, multi: MACHINE.multi }; }
  const isActive = (x) => (x.m === undefined || x.m === 'both' || x.m === MACHINE.type) && (!x.multi || (MACHINE.type === 'mill' && MACHINE.multi));
  /* the converted text may only use axis letters the chosen machine has (so "rapid to X1 Y2" is not a lathe phrase) */
  function lettersOk(out) {
    const allowed = allowedAxisLetters(), code = String(out).replace(/\([^)]*\)/g, ' ');
    const re = /(?:^|[\s;])([A-Z])(?=-?[\d.])/g; let m;
    while ((m = re.exec(code))) { if (AXIS_WORDS.includes(m[1]) && !allowed.includes(m[1])) return false; }
    return true;
  }

  /* A phrase is only converted when the G-code it would give is sane: a feed above zero, a tool, spindle speed, offset or axis value in
     range, and no axis twice in one block. Otherwise the line is left exactly as typed (so "feed to X1 at 0", "spindle on 99999999999" and
     "boring at X0x10" are not turned into bad G-code). */
  function outputOk(out) {
    for (const raw of String(out).split('\n')) {
      const line = raw.replace(/\([^)]*\)/g, ' '), seen = {}, re = /(?:^|[\s;])([A-Z])(-?(?:\d+\.?\d*|\.\d+))(?=$|[\s;])/g; let m;
      while ((m = re.exec(line))) {
        const L = m[1], v = parseFloat(m[2]); if (!Number.isFinite(v)) return false;
        if (L === 'F' && !(v > 0 && v <= 100000)) return false;
        if (L === 'S' && !(v >= 0 && v <= 60000)) return false;
        if (L === 'T' && !(Number.isInteger(v) && v >= 0 && v <= (MACHINE.type === 'lathe' ? 9999 : 99))) return false;
        if ((L === 'H' || L === 'D') && !(Number.isInteger(v) && v >= 0 && v <= 999)) return false;
        if ('XYZABCUVWIJKRQP'.includes(L) && Math.abs(v) > 1e5) return false;
        if ('XYZABCUVWIJK'.includes(L)) { if (seen[L]) return false; seen[L] = 1; }
      }
    }
    return true;
  }

  // ----------------------------------------------------------
  // UNIT DETECTION
  // ----------------------------------------------------------

  function detectUnits(text) {
    let u = null;
    for (const line of text.split('\n')) {
      const t = line.replace(/\(.*?\)/g, '').toUpperCase();
      // (G20 / G21 can be written with no space around them, like G20G90, X1G21 or G90G21, so a plain word boundary is not enough:
      //  read every G word, skip one glued to a letter (that is not a G word), and look at its number)
      const re = /G(\d+(?:\.\d+)?)/g; let m;
      while ((m = re.exec(t))) { if (m.index > 0 && /[A-Z]/.test(t[m.index - 1])) continue; const v = parseFloat(m[1]); if (v === 20) u = 'inch'; else if (v === 21) u = 'metric'; }
    }
    return u;
  }

  // ----------------------------------------------------------
  // LAST MOTION MODAL TRACKING
  // ----------------------------------------------------------

  function getLastMotionModal(textBefore) {
    const lines = textBefore.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith('(')) continue;
      const match = line.match(/\bG(?:0?0|0?1|0?2|0?3)\b/);
      if (match) {
        const code = match[0].toUpperCase();
        if (code === 'G0') return 'G00';
        if (code === 'G1') return 'G01';
        if (code === 'G2') return 'G02';
        if (code === 'G3') return 'G03';
        return code;
      }
    }
    return null;
  }

  // ----------------------------------------------------------
  // SHORTCUTS  (exact-phrase matches, no placeholders)
  // ----------------------------------------------------------

  const SHORTCUTS = [
    { name: 'safety line', pattern: /^(?:safety\s+line(?:\s+for\s+mill)?|mill\s+safety|safe\s+start|init\s+line)$/i,
      desc: 'Mill safety line', convert: () => 'G00 G17 G40 G49 G80 G90' },
    { name: 'safety line inch', pattern: /^(?:safety\s+line\s+inch|inch\s+safety|safe\s+start\s+inch)$/i,
      desc: 'Safety line (inch)', convert: () => 'G00 G17 G20 G40 G49 G80 G90' },
    { name: 'safety line metric', pattern: /^(?:safety\s+line\s+metric|metric\s+safety|safe\s+start\s+metric)$/i,
      desc: 'Safety line (metric)', convert: () => 'G00 G17 G21 G40 G49 G80 G90' },
    { name: 'program header', pattern: /^(?:program\s+header|new\s+program|start\s+program)$/i,
      desc: 'New program header block',
      convert: () => `%\nO0001 (PART NAME)\n(DATE: ${new Date().toLocaleDateString()})\n(PROGRAMMER: )\n(MATERIAL: )\n(MACHINE: ${MACHINE.type === 'lathe' ? 'ST-20' : 'VF-2'})` },
    { name: 'home z', pattern: /^(?:home\s+z|z\s+home|retract\s+z)$/i,
      desc: 'Home Z (G28)', convert: () => 'G28 G91 Z0.\nG90' },
    { name: 'home all', pattern: /^(?:home\s+all|home\s+xy|home\s+xyz|return\s+home|go\s+home)$/i,
      desc: 'Home Z then XY', convert: () => 'G28 G91 Z0.\nG28 X0. Y0.\nG90' },
    { name: 'tool change block', pattern: /^(?:tool\s+change\s+block|tc\s+block)$/i,
      desc: 'Full tool change sequence',
      convert: () => 'M05\nM09\nG28 G91 Z0.\nG90\nT__ M06\nG43 H__ S____ M03\nG54\nM08' },
    { name: 'spindle start block', pattern: /^(?:spindle\s+start\s+block|start\s+cut|begin\s+cut)$/i,
      desc: 'Spindle + coolant start', convert: () => 'S____ M03\nG54\nM08' },
    { name: 'end block', pattern: /^(?:end\s+block|program\s+end\s+block|safe\s+end)$/i,
      desc: 'Safe end-of-program block',
      convert: () => 'M05\nM09\nG28 G91 Z0.\nG28 X0. Y0.\nG90\nM30\n%' },
    { name: 'css block', pattern: /^(?:css\s+block|constant\s+surface\s+speed\s+block|surface\s+speed\s+block)$/i,
      desc: 'CSS block with RPM clamp', convert: () => 'G96 S___ M03\nG50 S____' },
    { name: 'css off block', pattern: /^(?:css\s+off\s+block|end\s+css\s+block|rpm\s+mode\s+block)$/i,
      desc: 'Cancel CSS back to RPM', convert: () => 'G97 S____ M03' },
    { name: 'drill block', pattern: /^(?:drill\s+block|drilling\s+block)$/i,
      desc: 'G81 drill cycle template', convert: () => 'G81 G99 X__. Y__. Z-__. R__. F__.\nG80' },
    { name: 'peck block', pattern: /^(?:peck\s+(?:drill\s+)?block|peck\s+drilling\s+block)$/i,
      desc: 'G83 peck drill template', convert: () => 'G83 G99 X__. Y__. Z-__. Q__. R__. F__.\nG80' },
    { name: 'tap block', pattern: /^(?:tap\s+block|tapping\s+block|rigid\s+tap\s+block)$/i,
      desc: 'M29 + G84 rigid tap template', convert: () => 'M29 S____\nG84 G99 X__. Y__. Z-__. R__. F__.\nG80' },
    { name: 'bore block', pattern: /^(?:bore\s+block|boring\s+block)$/i,
      desc: 'G85 boring cycle template', convert: () => 'G85 G99 X__. Y__. Z-__. R__. F__.\nG80' },
    { name: 'chip break block', pattern: /^(?:chip\s+break\s+block)$/i,
      desc: 'G73 chip break cycle template', convert: () => 'G73 G99 X__. Y__. Z-__. Q__. R__. F__.\nG80' },
    { name: 'fine bore block', pattern: /^(?:fine\s+bore\s+block)$/i,
      desc: 'G76 fine boring template', convert: () => 'G76 G99 X__. Y__. Z-__. R__. Q__. P__ F__.\nG80' },
    { name: 'part zero', pattern: /^(?:part\s+zero|go\s+to\s+zero|xyz\s+zero|move\s+to\s+zero)$/i,
      desc: 'Rapid to part zero in G54', convert: () => 'G90 G00 G54 X0. Y0.' },
    { name: 'clear z', pattern: /^(?:clear\s+z|z\s+clear|z\s+safe|safe\s+z)$/i,
      desc: 'G00 Z to safe height', convert: () => 'G90 G00 Z1.' },
    { name: 'wcs block', pattern: /^(?:wcs\s+block|work\s+coord\s+block|set\s+wcs)$/i,
      desc: 'G10 work coord set', convert: () => 'G10 L2 P1 X__. Y__. Z__.' },
    { name: 'sub block', pattern: /^(?:sub\s+block|subroutine\s+block|macro\s+block)$/i,
      desc: 'Subroutine template', convert: () => 'O____ (SUBROUTINE NAME)\n\nM99' },
    { name: 'optional stop', pattern: /^(?:op\s+stop|optional\s+stop)$/i,
      desc: 'Optional stop (M01)', convert: () => 'M01' },
    { name: 'program stop', pattern: /^(?:program\s+stop|hard\s+stop)$/i,
      desc: 'Program stop (M00)', convert: () => 'M00' },
    { name: 'mist on', pattern: /^(?:mist\s+on|mist\s+coolant\s+on)$/i,
      desc: 'Mist coolant on', convert: () => 'M07' },
    { name: 'tsc on', pattern: /^(?:tsc\s+on|through\s+spindle\s+coolant|high\s+pressure\s+coolant)$/i,
      desc: 'Through-spindle coolant', convert: () => 'M88' },
    { name: 'tsc off', pattern: /^(?:tsc\s+off)$/i,
      desc: 'TSC off', convert: () => 'M89' },
    { name: 'air blast on', pattern: /^(?:air\s+(?:blast\s+)?on)$/i,
      desc: 'Air blast on (M12)', convert: () => 'M12' },
    { name: 'air blast off', pattern: /^(?:air\s+(?:blast\s+)?off)$/i,
      desc: 'Air blast off (M13)', convert: () => 'M13' },
    { name: 'conveyor on', pattern: /^(?:conveyor\s+on|chip\s+conveyor\s+on)$/i,
      desc: 'Chip conveyor on (M31)', convert: () => 'M31' },
    { name: 'conveyor off', pattern: /^(?:conveyor\s+off|chip\s+conveyor\s+off)$/i,
      desc: 'Chip conveyor off (M33)', convert: () => 'M33' },
    { name: 'probe block', pattern: /^(?:probe\s+block|probe\s+wcs)$/i,
      desc: 'Renishaw probe stub',
      convert: () => '(PROBE - SET WCS)\nG65 P9810 Z__. F__.\nG65 P9811 X__. D__. Z__.' },
    { name: 'b axis index', pattern: /^(?:b\s+axis\s+index|index\s+b)$/i,
      desc: 'B-axis index stub', convert: () => 'G00 G90 B__.\nM19' },
    { name: 'max spindle speed', hidden: true, pattern: /^(?:max\s+spindle\s+speed)\s+(\d+)$/i,
      desc: 'Max spindle speed (G97 S... M03)', convert: m => `G97 S${m[1]} M03` },
    { name: 'spindle clamp', hidden: true, pattern: /^(?:spindle\s+(?:clamp|max|limit))\s+(\d+)$/i,
      desc: 'Max spindle clamp (G50)', convert: m => `G50 S${m[1]}` },
  ];

  // ----------------------------------------------------------
  // G-CODE & M-CODE REFERENCE TABLES
  // ----------------------------------------------------------

  const GCODES = {
    'G00': 'Rapid', 'G01': 'Linear feed', 'G02': 'Arc CW', 'G03': 'Arc CCW', 'G04': 'Dwell',
    'G10': 'Set offset data', 'G12': 'Circular pocket CW', 'G13': 'Circular pocket CCW',
    'G17': 'XY plane', 'G18': 'XZ plane', 'G19': 'YZ plane',
    'G20': 'Inch', 'G21': 'Metric',
    'G28': 'Machine home', 'G29': 'Return from ref',
    'G40': 'Cancel cutter comp', 'G41': 'Cutter comp left', 'G42': 'Cutter comp right',
    'G43': 'Tool length comp +', 'G44': 'Tool length comp -', 'G49': 'Cancel TLC',
    'G50': 'Max spindle clamp', 'G51': 'Scaling', 'G52': 'Local coord offset',
    'G53': 'Machine coord', 'G54': 'Work offset 1', 'G55': 'Work offset 2',
    'G56': 'Work offset 3', 'G57': 'Work offset 4', 'G58': 'Work offset 5', 'G59': 'Work offset 6',
    'G65': 'Macro call', 'G68': 'Coord rotation', 'G69': 'Cancel rotation',
    'G73': 'Chip break drill', 'G74': 'Left-hand tap', 'G76': 'Fine boring',
    'G80': 'Cancel canned cycle', 'G81': 'Drill', 'G82': 'Drill + dwell',
    'G83': 'Peck drill', 'G84': 'Right-hand tap', 'G85': 'Boring (feed out)',
    'G86': 'Boring (stop)', 'G87': 'Back boring', 'G89': 'Boring + dwell',
    'G90': 'Absolute', 'G91': 'Incremental', 'G92': 'Coord set',
    'G94': 'Feed/min', 'G95': 'Feed/rev', 'G96': 'CSS mode', 'G97': 'RPM mode',
    'G98': 'Return initial plane', 'G99': 'Return R plane',
  };

  const MCODES = {
    'M00': 'Program stop', 'M01': 'Optional stop', 'M02': 'End',
    'M03': 'Spindle CW', 'M04': 'Spindle CCW', 'M05': 'Spindle stop',
    'M06': 'Tool change', 'M07': 'Mist coolant', 'M08': 'Flood coolant', 'M09': 'Coolant off',
    'M12': 'Air blast on', 'M13': 'Air blast off',
    'M19': 'Spindle orient', 'M29': 'Rigid tap mode', 'M30': 'End & rewind',
    'M31': 'Conveyor fwd', 'M33': 'Conveyor off',
    'M88': 'TSC on', 'M89': 'TSC off',
    'M97': 'Local sub', 'M98': 'Subprogram call', 'M99': 'Sub return',
  };

  // ----------------------------------------------------------
  // NL RULES  (natural-language pattern → gcode string)
  // Add new rules here. Order matters — first match wins.
  // ----------------------------------------------------------

  const NL_RULES = [
    { pattern: /quick\s+tool\s+change\s+T(\d+)/i,
      convert: m => {
        const t = m[1].replace(/^0+(?=\d)/, '').padStart(2, '0');
        const h = m[1].replace(/^0+(?=\d)/, '').padStart(2, '0');
        return `T${t} M06\nG00 G90 G40 G49 G54\nG00 G54 X0 Y0\nS1000 M03\nG43 H${h} Z0.1\nM08`;
      }
    },
    { pattern: /(?:change\s+tool\s+to|tool\s+change\s+to?|use\s+tool|load\s+tool|select\s+tool|switch\s+to\s+tool)\s+T?(\d+)/i,
      convert: m => { const t = m[1].replace(/^0+(?=\d)/, '').padStart(2, '0'); return `T${t} M06`; } },
    { pattern: /^T(\d+)\s+M0?6$/i,
      convert: m => { const t = m[1].replace(/^0+(?=\d)/, '').padStart(2, '0'); return `T${t} M06`; } },
    { pattern: /(?:spindle\s+(?:on|start|cw|clockwise)|start\s+spindle|turn\s+on\s+spindle)(?:\s+(?:at\s+)?(\d+)(?:\s*rpm)?)?/i,
      convert: m => m[1] ? `S${m[1]} M03` : `M03` },
    { pattern: /(?:spindle\s+(?:ccw|counterclockwise|reverse)|reverse\s+spindle)(?:\s+(?:at\s+)?(\d+)(?:\s*rpm)?)?/i,
      convert: m => m[1] ? `S${m[1]} M04` : `M04` },
    { pattern: /(?:set\s+spindle(?:\s+speed)?\s+to|spindle\s+speed)\s+(\d+)(?:\s*rpm)?/i,
      convert: m => `S${m[1]} M03` },
    { pattern: /(?:stop\s+spindle|spindle\s+(?:off|stop))/i, convert: () => 'M05' },
    { pattern: /(?:css|constant\s+surface\s+speed|surface\s+speed)\s+(\d+)(?:\s*(?:sfm|fpm|m\/min|sfpm))?(?:\s+(?:max|clamp|limit)\s+(\d+)(?:\s*rpm)?)?/i,
      convert: m => { const s = m[1], mx = m[2]; return mx ? `G96 S${s} M03\nG50 S${mx}` : `G96 S${s} M03`; } },
    { pattern: /(?:css\s+off|end\s+css|(?:constant\s+)?rpm\s+mode)(?:\s+(\d+)(?:\s*rpm)?)?/i,
      convert: m => m[1] ? `G97 S${m[1]} M03` : `G97` },
    { pattern: /max\s+spindle\s+speed\s+(\d+)/i, convert: m => `G97 S${m[1]} M03` },
    { pattern: /(?:spindle\s+(?:clamp|max|limit))\s+(\d+)/i, convert: m => `G50 S${m[1]}` },
    { pattern: /(?:coolant\s+on|turn\s+on\s+coolant|flood\s+coolant|start\s+coolant)/i, convert: () => 'M08' },
    { pattern: /(?:coolant\s+off|turn\s+off\s+coolant|stop\s+coolant)/i, convert: () => 'M09' },
    { pattern: /(?:mist\s+(?:on|coolant)|coolant\s+mist)/i, convert: () => 'M07' },
    { pattern: /(?:through\s+(?:spindle\s+)?coolant|tsc\s+on|high\s+pressure)/i, convert: () => 'M88' },
    { pattern: /(?:rapid(?:\s+to)?|go\s+rapid\s+to|move\s+rapid(?:ly)?\s+to|position\s+to)\s+((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: (m) => { const c = parseCoords(m[1]); return m[2] ? `G00 ${c} F${fmtNum(m[2])}` : `G00 ${c}`; } },
    { pattern: /(?:feed(?:\s+to)?|linear\s+move(?:\s+to)?|mill\s+to|cut\s+to)\s+((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: (m) => { const c = parseCoords(m[1]); return m[2] ? `G01 ${c} F${fmtNum(m[2])}` : `G01 ${c}`; } },
    { pattern: /(?:go\s+to|move\s+to|position\s+to)\s+((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: (m, ctx) => {
        let modal = 'G00';
        if (ctx && ctx.lastMotionModal) {
          const mModal = ctx.lastMotionModal;
          if (mModal === 'G00' || mModal === 'G01' || mModal === 'G02' || mModal === 'G03') modal = mModal;
        }
        const c = parseCoords(m[1]);
        return m[2] ? `${modal} ${c} F${fmtNum(m[2])}` : `${modal} ${c}`;
      }
    },
    // Arc CW with R
    { pattern: /(?:arc\s+(?:cw|clockwise)|(?<![a-z])cw\s+arc)\s+(?:to\s+)?((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)\s*R(-?(?:\d+\.?\d*|\.\d+))(?:\s*I(-?(?:\d+\.?\d*|\.\d+)))?(?:\s*J(-?(?:\d+\.?\d*|\.\d+)))?(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: m => {
        const c = parseCoords(m[1]);
        const f = m[5] ? ` F${fmtNum(m[5])}` : '';
        return `G02 ${c} R${fmtNum(m[2])}${f}`;
      }
    },
    // Arc CW with I/J
    { pattern: /(?:arc\s+(?:cw|clockwise)|(?<![a-z])cw\s+arc)\s+(?:to\s+)?((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)(?:\s*I(-?(?:\d+\.?\d*|\.\d+)))?(?:\s*J(-?(?:\d+\.?\d*|\.\d+)))?(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: m => {
        const c = parseCoords(m[1]);
        const f = m[4] ? ` F${fmtNum(m[4])}` : '';
        return `G02 ${c}${m[2] ? ' I' + fmtNum(m[2]) : ''}${m[3] ? ' J' + fmtNum(m[3]) : ''}${f}`;
      }
    },
    // Arc CCW with R
    { pattern: /(?:arc\s+(?:ccw|counterclockwise|counter-clockwise)|ccw\s+arc)\s+(?:to\s+)?((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)\s*R(-?(?:\d+\.?\d*|\.\d+))(?:\s*I(-?(?:\d+\.?\d*|\.\d+)))?(?:\s*J(-?(?:\d+\.?\d*|\.\d+)))?(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: m => {
        const c = parseCoords(m[1]);
        const f = m[5] ? ` F${fmtNum(m[5])}` : '';
        return `G03 ${c} R${fmtNum(m[2])}${f}`;
      }
    },
    // Arc CCW with I/J
    { pattern: /(?:arc\s+(?:ccw|counterclockwise|counter-clockwise)|ccw\s+arc)\s+(?:to\s+)?((?:[XYZABCUVW]-?(?:\d+\.?\d*|\.\d+)\s*)+?)(?:\s*I(-?(?:\d+\.?\d*|\.\d+)))?(?:\s*J(-?(?:\d+\.?\d*|\.\d+)))?(?:\s+(?:at|feed|f)\s+(\d+\.?\d*|\.\d+)(?:\s*(?:ipm|fpm|mmpm|mm\/min|in\/min))?)?$/i,
      convert: m => {
        const c = parseCoords(m[1]);
        const f = m[4] ? ` F${fmtNum(m[4])}` : '';
        return `G03 ${c}${m[2] ? ' I' + fmtNum(m[2]) : ''}${m[3] ? ' J' + fmtNum(m[3]) : ''}${f}`;
      }
    },
    { pattern: /(?:dwell|wait|pause)\s+(\d+(?:\.\d+)?)\s*(?:s(?:ec(?:ond)?s?)?|ms|millisec(?:ond)?s?)?/i,
      convert: m => { let v = parseFloat(m[1]); if (/ms|milli/i.test(m[0])) v /= 1000; return `G04 P${v >= 1e21 ? m[1] : +v.toFixed(6)}`; } },   // (never 1e+21 notation)
    { pattern: /(?:home\s+z|z\s+home|retract\s+z)/i, convert: () => 'G28 G91 Z0.\nG90' },
    { pattern: /(?:go\s+(?:to\s+)?(?:machine\s+)?home|return\s+to\s+(?:machine\s+)?home|home\s+(?:all\s+)?axes)/i,
      convert: () => 'G28 G91 Z0.\nG28 X0. Y0.\nG90' },
    { pattern: /(?:optional\s+stop|program\s+(?:optional\s+)?stop)/i, convert: () => 'M01' },
    { pattern: /(?:stop\s+program|program\s+stop\b)/i, convert: () => 'M00' },
    { pattern: /(?:end\s+(?:of\s+)?program|program\s+end)/i, convert: () => 'M30\n%' },
    { pattern: /(?:set\s+)?absolute\s+(?:mode|programming)|use\s+absolute/i, convert: () => 'G90' },
    { pattern: /(?:set\s+)?incremental\s+(?:mode|programming)|use\s+incremental/i, convert: () => 'G91' },
    { pattern: /(?:set\s+)?(?:units?\s+to\s+)?(?:inches?|inch\s+mode|imperial)/i, convert: () => 'G20' },
    { pattern: /(?:set\s+)?(?:units?\s+to\s+)?(?:metric|millim(?:etr(?:es?|s?))?|mm\s+mode)/i, convert: () => 'G21' },
    { pattern: /feed\s+per\s+rev(?:olution)?/i, convert: () => 'G95' },
    { pattern: /feed\s+per\s+min(?:ute)?/i, convert: () => 'G94' },
    { pattern: /(?:set\s+|use\s+)?work\s+offset\s+(?:G?(\d+)|(\d+))/i,
      convert: m => { const n = parseInt(m[1] || m[2]); if (n >= 54 && n <= 59) return `G${n}`; return ({ 1: 'G54', 2: 'G55', 3: 'G56', 4: 'G57', 5: 'G58', 6: 'G59' })[n] || 'G54'; } },
    { pattern: /(?:enable|apply|activate|set|use)\s+tool\s+(?:length\s+)?comp(?:ensation)?\s+H(\d+)/i,
      convert: m => `G43 H${m[1].padStart(2, '0')}` },
    { pattern: /(?:cancel|disable|remove|turn\s+off)\s+tool\s+(?:length\s+)?comp(?:ensation)?/i,
      convert: () => 'G49' },
    { pattern: /cutter\s+comp(?:ensation)?\s+(?:left|climb)\s*(?:D\s*(\d+))?/i,
      convert: m => (m[1] ? `G41 D${m[1]}` : 'G41 D__') },
    { pattern: /cutter\s+comp(?:ensation)?\s+(?:right|conventional)\s*(?:D\s*(\d+))?/i,
      convert: m => (m[1] ? `G42 D${m[1]}` : 'G42 D__') },
    { pattern: /cancel\s+cutter\s+comp(?:ensation)?/i, convert: () => 'G40' },
    { pattern: /(?:drill\s+(?:hole\s+)?at|simple\s+drill)\s+((?:[XYZRQ]-?(?:\d+\.?\d*|\.\d+)\s*)*)(?:F(-?(?:\d+\.?\d*|\.\d+)))?/i,
      convert: (m) => `G81 G99 ${parseCoords(m[1])}${m[2] ? ' F' + m[2] : ''}` },
    { pattern: /(?:peck\s+drill(?:ing)?)\s+((?:[XYZRQ]-?(?:\d+\.?\d*|\.\d+)\s*)*)(?:F(-?(?:\d+\.?\d*|\.\d+)))?/i,
      convert: (m) => `G83 G99 ${parseCoords(m[1])}${m[2] ? ' F' + m[2] : ''}` },
    { pattern: /rigid\s+tap(?:\s+mode)?\s+(\d+)/i, convert: m => `M29 S${m[1]}` },
    { pattern: /(?:tap(?:ping)?(?:\s+(?:hole\s+)?at)?)\s+((?:[XYZR]-?(?:\d+\.?\d*|\.\d+)\s*)*)(?:F(-?(?:\d+\.?\d*|\.\d+)))?/i,
      convert: (m) => `G84 G99 ${parseCoords(m[1])}${m[2] ? ' F' + m[2] : ''}` },
    { pattern: /(?:chip\s+break(?:ing)?\s+drill)\s+((?:[XYZRQ]-?(?:\d+\.?\d*|\.\d+)\s*)*)(?:F(-?(?:\d+\.?\d*|\.\d+)))?/i,
      convert: (m) => `G73 G99 ${parseCoords(m[1])}${m[2] ? ' F' + m[2] : ''}` },
    { pattern: /(?:boring(?:\s+cycle)?|bore)(?:\s+at)?\s+((?:[XYZR]-?(?:\d+\.?\d*|\.\d+)\s*)*)(?:F(-?(?:\d+\.?\d*|\.\d+)))?/i,
      convert: (m) => `G85 G99 ${parseCoords(m[1])}${m[2] ? ' F' + m[2] : ''}` },
    { pattern: /cancel\s+(?:canned\s+)?cycle|end\s+(?:canned\s+)?cycle/i, convert: () => 'G80' },
    { pattern: /(?:select\s+)?XY\s+plane/i, convert: () => 'G17' },
    { pattern: /(?:select\s+)?XZ\s+plane/i, convert: () => 'G18' },
    { pattern: /(?:select\s+)?YZ\s+plane/i, convert: () => 'G19' },
    { pattern: /(?:call\s+sub(?:routine)?|run\s+sub(?:routine)?)\s+O?(\d+)/i,
      convert: m => `M98 P${m[1].padStart(4, '0')}` },
    { pattern: /^(?:comment|;)\s+(.+)/i, convert: m => `(${m[1].toUpperCase()})` },
    { pattern: /(?:rotate\s+coords?|coord\s+rotation)\s+(\d+(?:\.\d+)?)\s*(?:deg(?:rees?)?)?/i,
      convert: m => `G68 X0. Y0. R${m[1]}` },
    { pattern: /cancel\s+(?:coord\s+)?rotation/i, convert: () => 'G69' },
    { pattern: /(?:orient\s+spindle|spindle\s+orient)(?:\s+(\d+(?:\.\d+)?))?/i,
      convert: m => m[1] ? `M19 R${m[1]}` : 'M19' },
    { pattern: /(?:call\s+macro|macro\s+call)\s+(\d+)/i, convert: m => `G65 P${m[1]}` },
    { pattern: /air\s+(?:blast\s+)?on/i, convert: () => 'M12' },
    { pattern: /air\s+(?:blast\s+)?off/i, convert: () => 'M13' },
    { pattern: /(?:chip\s+)?conveyor\s+(?:on|fwd)/i, convert: () => 'M31' },
    { pattern: /(?:chip\s+)?conveyor\s+off/i, convert: () => 'M33' },
    { pattern: /scale\s+factor\s+(\d+\.?\d*|\.\d+)/i, convert: m => { const f = /\./.test(m[1]) ? m[1] : m[1] + '.'; return `G51 X${f} Y${f} Z${f}`; } },   // (axis words keep a decimal point)
    { pattern: /cancel\s+scale/i, convert: () => 'G50' },
    // Pocket milling
    { pattern: /(?:pocket\s+mill(?:ing)?\s+(?:cw|clockwise)|circular\s+pocket\s+(?:cw|clockwise))/i, convert: () => 'G12' },
    { pattern: /(?:pocket\s+mill(?:ing)?\s+(?:ccw|counterclockwise)|circular\s+pocket\s+(?:ccw|counterclockwise))/i, convert: () => 'G13' },
  ];

  // ----------------------------------------------------------
  // AUTOCOMPLETE SUGGESTIONS
  // Shown in the dropdown and cheat sheet.
  // Add a matching entry here whenever you add a new NL rule.
  // ----------------------------------------------------------

  const NL_SUGGESTIONS = [
    { code: 'safety line', desc: 'G00 G17 G40 G49 G80 G90', type: 'shortcut' },
    { code: 'safety line inch', desc: '+ G20', type: 'shortcut' },
    { code: 'safety line metric', desc: '+ G21', type: 'shortcut' },
    { code: 'program header', desc: 'New program block', type: 'shortcut' },
    { code: 'home z', desc: 'G28 G91 Z0.', type: 'shortcut' },
    { code: 'home all', desc: 'G28 Z + XY', type: 'shortcut' },
    { code: 'tool change block', desc: 'Full TC sequence', type: 'shortcut' },
    { code: 'end block', desc: 'Safe end of program', type: 'shortcut' },
    { code: 'css block', desc: 'G96 + G50 clamp', type: 'shortcut' },
    { code: 'css off block', desc: 'Back to G97', type: 'shortcut' },
    { code: 'drill block', desc: 'G81 template', type: 'shortcut' },
    { code: 'peck block', desc: 'G83 template', type: 'shortcut' },
    { code: 'tap block', desc: 'M29 + G84', type: 'shortcut' },
    { code: 'bore block', desc: 'G85 template', type: 'shortcut' },
    { code: 'chip break block', desc: 'G73 template', type: 'shortcut' },
    { code: 'fine bore block', desc: 'G76 template', type: 'shortcut' },
    { code: 'part zero', desc: 'G00 to X0 Y0 in G54', type: 'shortcut' },
    { code: 'clear z', desc: 'G00 Z1.', type: 'shortcut' },
    { code: 'wcs block', desc: 'G10 offset set', type: 'shortcut' },
    { code: 'sub block', desc: 'Subroutine template', type: 'shortcut' },
    { code: 'probe block', desc: 'Renishaw stub', type: 'shortcut' },
    { code: 'optional stop', desc: 'M01', type: 'shortcut' },
    { code: 'mist on', desc: 'M07', type: 'shortcut' },
    { code: 'tsc on', desc: 'M88', type: 'shortcut' },
    { code: 'air on / air off', desc: 'M12 / M13', type: 'shortcut' },
    { code: 'conveyor on / off', desc: 'M31 / M33', type: 'shortcut' },
    { code: 'quick tool change T##', desc: 'Full tool change block (T## M06, G43 H##, etc.)', type: 'nl' },
    { code: 'change tool to T##', desc: 'T## M06', type: 'nl' },
    { code: 'spindle on ####', desc: 'S#### M03', type: 'nl' },
    { code: 'CSS ### sfm', desc: 'G96 S### M03', type: 'nl' },
    { code: 'CSS ### sfm max #### rpm', desc: 'G96 + G50 clamp', type: 'nl' },
    { code: 'CSS off', desc: 'G97', type: 'nl' },
    { code: 'max spindle speed ####', desc: 'G97 S#### M03', type: 'nl' },
    { code: 'spindle clamp ####', desc: 'G50 S####', type: 'nl' },
    { code: 'rapid to X# Y# Z#', desc: 'G00', type: 'nl' },
    { code: 'feed to X# Y# Z# at ##', desc: 'G01 F##', type: 'nl' },
    { code: 'arc clockwise to X# Y# R#', desc: 'G02', type: 'nl' },
    { code: 'arc counterclockwise to X# Y# R#', desc: 'G03', type: 'nl' },
    { code: 'dwell # seconds', desc: 'G04 P#', type: 'nl' },
    { code: 'drill at X# Y# Z# R# F#', desc: 'G81 G99', type: 'nl' },
    { code: 'peck drill X# Y# Z# Q# R# F#', desc: 'G83 G99', type: 'nl' },
    { code: 'tap at X# Y# Z# R# F#', desc: 'G84 G99', type: 'nl' },
    { code: 'chip break drill X# Y# Z# Q# R# F#', desc: 'G73 G99', type: 'nl' },
    { code: 'boring at X# Y# Z# R# F#', desc: 'G85 G99', type: 'nl' },
    { code: 'cancel cycle', desc: 'G80', type: 'nl' },
    { code: 'enable tool comp H##', desc: 'G43 H##', type: 'nl' },
    { code: 'cancel tool comp', desc: 'G49', type: 'nl' },
    { code: 'cutter comp left D##', desc: 'G41 D##', type: 'nl' },
    { code: 'cutter comp right D##', desc: 'G42 D##', type: 'nl' },
    { code: 'cancel cutter comp', desc: 'G40', type: 'nl' },
    { code: 'absolute mode', desc: 'G90', type: 'nl' },
    { code: 'incremental mode', desc: 'G91', type: 'nl' },
    { code: 'work offset 1–6', desc: 'G54–G59', type: 'nl' },
    { code: 'rotate coords ## deg', desc: 'G68 X0. Y0. R##', type: 'nl' },
    { code: 'rigid tap mode ####', desc: 'M29 S####', type: 'nl' },
    { code: 'scale factor #.#', desc: 'G51', type: 'nl' },
    { code: 'end program', desc: 'M30 + %', type: 'nl' },
    { code: 'pocket milling cw', desc: 'G12', type: 'nl' },
    { code: 'pocket milling ccw', desc: 'G13', type: 'nl' },
  ];


  // ----------------------------------------------------------
  // MACHINE TAGS  (which rules belong to a mill, a lathe, or both)
  // Anything not listed here works on both. New lathe / multiaxis rules are added below the tags.
  // ----------------------------------------------------------

  const tagBy = (list, key, map) => list.forEach((x, i) => { const t = map[key(x, i)]; if (t) { x.m = t.m || t; if (t.multi) x.multi = true; } });
  const MILL = 'mill', LATHE = 'lathe';
  tagBy(SHORTCUTS, (x) => x.name, {
    'safety line': MILL, 'safety line inch': MILL, 'safety line metric': MILL, 'home z': MILL, 'home all': MILL, 'tool change block': MILL,
    'end block': MILL, 'drill block': MILL, 'peck block': MILL, 'tap block': MILL, 'bore block': MILL, 'chip break block': MILL,
    'fine bore block': MILL, 'part zero': MILL, 'clear z': MILL, 'wcs block': MILL, 'probe block': MILL,
    'css block': LATHE, 'css off block': LATHE, 'max spindle speed': LATHE, 'spindle clamp': LATHE,
    'b axis index': { m: MILL, multi: true },
  });
  const NL_MILL = [0, 1, 2, 23, 24, 32, 33, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 47, 49, 52, 53, 54, 60, 61, 62, 63], NL_LATHE = [7, 8, 9, 10];
  NL_RULES.forEach((r, i) => { if (NL_MILL.includes(i)) r.m = MILL; else if (NL_LATHE.includes(i)) r.m = LATHE; });
  NL_RULES[16].skipIf = { lathe: /\bmill\s+to\b/i };   // ("mill to" is a mill phrase)
  NL_RULES[5].skipIf = { mill: /\bmax\s+spindle\s+speed\b/i };   // ("max spindle speed" is the lathe's G97 / G50 wording)
  tagBy(NL_SUGGESTIONS, (x) => x.code, {
    'safety line': MILL, 'safety line inch': MILL, 'safety line metric': MILL, 'home z': MILL, 'home all': MILL, 'tool change block': MILL,
    'end block': MILL, 'css block': LATHE, 'css off block': LATHE, 'drill block': MILL, 'peck block': MILL, 'tap block': MILL, 'bore block': MILL,
    'chip break block': MILL, 'fine bore block': MILL, 'part zero': MILL, 'clear z': MILL, 'wcs block': MILL, 'probe block': MILL,
    'quick tool change T##': MILL, 'change tool to T##': MILL, 'CSS ### sfm': LATHE, 'CSS ### sfm max #### rpm': LATHE, 'CSS off': LATHE,
    'max spindle speed ####': LATHE, 'spindle clamp ####': LATHE, 'drill at X# Y# Z# R# F#': MILL, 'peck drill X# Y# Z# Q# R# F#': MILL,
    'tap at X# Y# Z# R# F#': MILL, 'chip break drill X# Y# Z# Q# R# F#': MILL, 'boring at X# Y# Z# R# F#': MILL, 'enable tool comp H##': MILL,
    'cancel tool comp': MILL, 'cutter comp left D##': MILL, 'cutter comp right D##': MILL, 'cancel cutter comp': MILL, 'rotate coords ## deg': MILL,
    'rigid tap mode ####': MILL, 'scale factor #.#': MILL, 'rapid to X# Y# Z#': MILL, 'feed to X# Y# Z# at ##': MILL, 'arc clockwise to X# Y# R#': MILL, 'arc counterclockwise to X# Y# R#': MILL, 'pocket milling cw': MILL, 'pocket milling ccw': MILL,
  });

  // ---- lathe-only additions (turning phrases; a lathe knows X, Z and the incremental U, W) ----
  const NUM = '(?:\\d+\\.?\\d*|\\.\\d+)', LCO = '((?:[XZUW]-?' + NUM + '\\s*)+?)';
  const toolNo = (v) => v.replace(/^0+(?=\d)/, '').padStart(2, '0');
  const lathe = (o) => Object.assign({ m: LATHE }, o);
  SHORTCUTS.push(
    lathe({ name: 'safety line', pattern: /^(?:safety\s+line(?:\s+for\s+lathe)?|lathe\s+safety|safe\s+start|init\s+line)$/i, desc: 'Lathe safety line', convert: () => 'G00 G18 G40 G80 G99' }),
    lathe({ name: 'safety line inch', pattern: /^(?:safety\s+line\s+inch|inch\s+safety|safe\s+start\s+inch)$/i, desc: 'Lathe safety line (inch)', convert: () => 'G00 G18 G20 G40 G80 G99' }),
    lathe({ name: 'safety line metric', pattern: /^(?:safety\s+line\s+metric|metric\s+safety|safe\s+start\s+metric)$/i, desc: 'Lathe safety line (metric)', convert: () => 'G00 G18 G21 G40 G80 G99' }),
    lathe({ name: 'home x', pattern: /^(?:home\s+x|x\s+home|retract\s+x)$/i, desc: 'Home X (G28 U0.)', convert: () => 'G28 U0.' }),
    lathe({ name: 'home z', pattern: /^(?:home\s+z|z\s+home|retract\s+z)$/i, desc: 'Home Z (G28 W0.)', convert: () => 'G28 W0.' }),
    lathe({ name: 'home all', pattern: /^(?:home\s+all|home\s+xz|home\s+xyz|return\s+home|go\s+home)$/i, desc: 'Home X then Z', convert: () => 'G28 U0.\nG28 W0.' }),
    lathe({ name: 'tool change block', pattern: /^(?:tool\s+change\s+block|tc\s+block)$/i, desc: 'Full lathe tool change sequence', convert: () => 'M05\nM09\nG28 U0.\nG28 W0.\nT____\nG97 S____ M03\nG54\nM08' }),
    lathe({ name: 'end block', pattern: /^(?:end\s+block|program\s+end\s+block|safe\s+end)$/i, desc: 'Safe end-of-program block (lathe)', convert: () => 'M05\nM09\nG28 U0.\nG28 W0.\nM30\n%' }),
    lathe({ name: 'part zero', pattern: /^(?:part\s+zero|go\s+to\s+zero|xz\s+zero|move\s+to\s+zero)$/i, desc: 'Rapid to part zero in G54', convert: () => 'G00 G54 X0. Z0.' }),
    lathe({ name: 'clear z', pattern: /^(?:clear\s+z|z\s+clear|z\s+safe|safe\s+z)$/i, desc: 'G00 Z to safe distance', convert: () => 'G00 Z.1' }),
    lathe({ name: 'wcs block', pattern: /^(?:wcs\s+block|work\s+coord\s+block|set\s+wcs)$/i, desc: 'G10 work coord set (lathe)', convert: () => 'G10 L2 P1 X__. Z__.' }),
  );
  NL_RULES.push(
    lathe({ pattern: new RegExp('(?:turn\\s+to|face\\s+to)\\s+' + LCO + '(?:\\s+(?:at|feed|f)\\s+(' + NUM + ')(?:\\s*(?:ipr|mmpr|in\\/rev|mm\\/rev|ipm|mm\\/min))?)?$', 'i'),
      convert: (m) => { const c = parseCoords(m[1]); return m[2] ? `G01 ${c} F${fmtNum(m[2])}` : `G01 ${c}`; } }),
    lathe({ pattern: /(?:change\s+tool\s+to|tool\s+change\s+to?|use\s+tool|load\s+tool|select\s+tool|switch\s+to\s+tool)\s+T?(\d+)(?:\s+(?:offset|off|wear)\s+(\d+))?/i,
      convert: (m) => { const t = toolNo(m[1]), o = toolNo(m[2] != null ? m[2] : m[1]); return t.length > 2 || o.length > 2 ? null : `T${t}${o}`; } }),
    lathe({ pattern: /(?:home\s+z|z\s+home|retract\s+z)/i, convert: () => 'G28 W0.' }),
    lathe({ pattern: /(?:home\s+x|x\s+home|retract\s+x)/i, convert: () => 'G28 U0.' }),
    lathe({ pattern: /(?:go\s+(?:to\s+)?(?:machine\s+)?home|return\s+to\s+(?:machine\s+)?home|home\s+(?:all\s+)?axes)/i, convert: () => 'G28 U0.\nG28 W0.' }),
    lathe({ pattern: /feed\s+per\s+rev(?:olution)?/i, convert: () => 'G99' }),
    lathe({ pattern: /feed\s+per\s+min(?:ute)?/i, convert: () => 'G98' }),
    lathe({ pattern: /cancel\s+(?:tool\s+)?nose\s+comp(?:ensation)?/i, convert: () => 'G40' }),
    lathe({ pattern: /(?:tool\s+)?nose\s+comp(?:ensation)?\s+left/i, convert: () => 'G41' }),
    lathe({ pattern: /(?:tool\s+)?nose\s+comp(?:ensation)?\s+right/i, convert: () => 'G42' }),
    lathe({ pattern: new RegExp('rough(?:ing)?\\s+turn(?:ing)?\\s+N?(\\d+)\\s+(?:to\\s+)?N?(\\d+)((?:\\s+[DRUWF]\\s*' + NUM + ')*)$', 'i'),
      convert: (m) => { const k = {}; String(m[3] || '').replace(new RegExp('([DRUWF])\\s*(' + NUM + ')', 'gi'), (_, l, v) => { k[l.toUpperCase()] = fmtNum(v); return ''; });
        return `G71 U${k.D || '__.'} R${k.R || '__.'}\nG71 P${m[1]} Q${m[2]}${k.U ? ' U' + k.U : ''}${k.W ? ' W' + k.W : ''}${k.F ? ' F' + k.F : ''}`; } }),
    lathe({ pattern: new RegExp('finish(?:ing)?\\s+(?:pass|cycle)\\s+N?(\\d+)\\s+(?:to\\s+)?N?(\\d+)(?:\\s+F\\s*(' + NUM + '))?$', 'i'),
      convert: (m) => `G70 P${m[1]} Q${m[2]}${m[3] ? ' F' + fmtNum(m[3]) : ''}` }),
    lathe({ pattern: new RegExp('thread(?:ing)?(?:\\s+to)?\\s+' + LCO + '\\s*(?:pitch|lead|f)\\s*(' + NUM + ')$', 'i'),
      convert: (m) => `G32 ${parseCoords(m[1])} F${fmtNum(m[2])}` }),
  );
  NL_SUGGESTIONS.push(
    lathe({ code: 'safety line', desc: 'G00 G18 G40 G80 G99', type: 'shortcut' }),
    lathe({ code: 'safety line inch', desc: '+ G20', type: 'shortcut' }),
    lathe({ code: 'safety line metric', desc: '+ G21', type: 'shortcut' }),
    lathe({ code: 'home x', desc: 'G28 U0.', type: 'shortcut' }),
    lathe({ code: 'home z', desc: 'G28 W0.', type: 'shortcut' }),
    lathe({ code: 'home all', desc: 'G28 U0. + W0.', type: 'shortcut' }),
    lathe({ code: 'tool change block', desc: 'Full lathe TC sequence', type: 'shortcut' }),
    lathe({ code: 'end block', desc: 'Safe end of program', type: 'shortcut' }),
    lathe({ code: 'part zero', desc: 'G00 to X0 Z0 in G54', type: 'shortcut' }),
    lathe({ code: 'clear z', desc: 'G00 Z.1', type: 'shortcut' }),
    lathe({ code: 'wcs block', desc: 'G10 offset set', type: 'shortcut' }),
    lathe({ code: 'change tool to T## offset ##', desc: 'T#### (tool + offset)', type: 'nl' }),
    lathe({ code: 'rapid to X# Z#', desc: 'G00', type: 'nl' }),
    lathe({ code: 'feed to X# Z# at ##', desc: 'G01 F##', type: 'nl' }),
    lathe({ code: 'arc clockwise to X# Z# R#', desc: 'G02', type: 'nl' }),
    lathe({ code: 'arc counterclockwise to X# Z# R#', desc: 'G03', type: 'nl' }),
    lathe({ code: 'turn to X# Z# at #', desc: 'G01 F#', type: 'nl' }),
    lathe({ code: 'face to X# Z# at #', desc: 'G01 F#', type: 'nl' }),
    lathe({ code: 'rough turn N## N## D# R# U# W# F#', desc: 'G71 rough turn cycle', type: 'nl' }),
    lathe({ code: 'finish pass N## N## F#', desc: 'G70 finish cycle', type: 'nl' }),
    lathe({ code: 'thread to X# Z# pitch #', desc: 'G32 thread', type: 'nl' }),
    lathe({ code: 'nose comp left / right', desc: 'G41 / G42', type: 'nl' }),
    lathe({ code: 'cancel nose comp', desc: 'G40', type: 'nl' }),
    lathe({ code: 'feed per rev / minute', desc: 'G99 / G98', type: 'nl' }),
  );

  // ---- multiaxis mill additions (only when Multiaxis is checked in mill mode) ----
  const multi = (o) => Object.assign({ m: MILL, multi: true }, o);
  SHORTCUTS.push(
    multi({ name: 'a axis index', pattern: /^(?:a\s+axis\s+index|index\s+a)$/i, desc: 'A-axis index stub', convert: () => 'G00 G90 A__.\nM19' }),
    multi({ name: 'c axis index', pattern: /^(?:c\s+axis\s+index|index\s+c)$/i, desc: 'C-axis index stub', convert: () => 'G00 G90 C__.\nM19' }),
    multi({ name: 'tcp on', pattern: /^(?:tcp\s+on|tool\s+center\s+point\s+on)$/i, desc: 'Tool center point control on (G43.4)', convert: () => 'G43.4 H__' }),
    multi({ name: 'tcp off', pattern: /^(?:tcp\s+off|tool\s+center\s+point\s+off)$/i, desc: 'Tool center point control off (G49)', convert: () => 'G49' }),
  );
  NL_SUGGESTIONS.push(
    multi({ code: 'b axis index', desc: 'B-axis index stub', type: 'shortcut' }),
    multi({ code: 'a axis index', desc: 'A-axis index stub', type: 'shortcut' }),
    multi({ code: 'c axis index', desc: 'C-axis index stub', type: 'shortcut' }),
    multi({ code: 'tcp on', desc: 'G43.4 H__', type: 'shortcut' }),
    multi({ code: 'tcp off', desc: 'G49', type: 'shortcut' }),
  );

  // ---- G / M code tables per machine ----
  const G_LATHE_ONLY = { G32: 'Thread cutting', G70: 'Finish cycle', G71: 'Rough turn cycle', G72: 'Rough face cycle', G75: 'OD / ID groove cycle', G96: 'CSS mode', G97: 'RPM mode' };
  const G_LATHE_DESC = { G50: 'Max spindle clamp', G73: 'Pattern repeat cycle', G74: 'Peck drill / face groove', G76: 'Threading cycle', G98: 'Feed per minute', G99: 'Feed per revolution' };
  const G_MILL_ONLY = new Set(['G12', 'G13', 'G17', 'G19', 'G43', 'G44', 'G49', 'G51', 'G68', 'G69', 'G81', 'G82', 'G83', 'G84', 'G85', 'G86', 'G87', 'G89', 'G94', 'G95']);
  const G_MILL_DESC = { G50: 'Cancel scaling', G73: 'Chip break drill', G74: 'Left-hand tap', G76: 'Fine boring', G98: 'Return initial plane', G99: 'Return R plane' };
  const M_MILL_ONLY = new Set(['M06', 'M19', 'M29']);
  function gTable() {
    const out = {};
    for (const [c, d] of Object.entries(GCODES)) {
      if (c in G_LATHE_ONLY || c in G_LATHE_DESC) continue;
      if (MACHINE.type === 'lathe' && G_MILL_ONLY.has(c)) continue;
      out[c] = d;
    }
    if (MACHINE.type === 'lathe') Object.assign(out, G_LATHE_ONLY, G_LATHE_DESC);
    else { Object.keys(G_MILL_DESC).forEach((c) => { out[c] = G_MILL_DESC[c]; }); if (MACHINE.multi) out['G43.4'] = 'Tool center point control'; }
    return Object.fromEntries(Object.entries(out).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })));
  }
  function mTable() {
    const out = {};
    for (const [c, d] of Object.entries(MCODES)) { if (MACHINE.type === 'lathe' && M_MILL_ONLY.has(c)) continue; out[c] = d; }
    return out;
  }

  // ----------------------------------------------------------
  // CORE CONVERTER
  // ----------------------------------------------------------

  function tryConvertLine(rawLine, context = {}) {
    const trimmed = rawLine.trim();
    if (!trimmed) return null;
    if (/^\(/.test(trimmed)) return null;
    if (/^%/.test(trimmed)) return null;
    const hasNL = /[a-z]{3,}/.test(trimmed);
    if (!hasNL && /^[GMTNOFSXYZABCUVW][- \d]/.test(trimmed)) return null;

    for (const sc of SHORTCUTS) {
      if (!isActive(sc)) continue;
      const m = trimmed.match(sc.pattern);
      if (m) { const r = sc.convert(m, context); if (r != null && lettersOk(r) && outputOk(r)) return r; }
    }
    for (const rule of NL_RULES) {
      if (!isActive(rule)) continue;
      if (rule.skipIf && rule.skipIf[MACHINE.type] && rule.skipIf[MACHINE.type].test(trimmed)) continue;
      const m = trimmed.match(rule.pattern);
      if (m) { const r = rule.convert(m, context); if (r != null && lettersOk(r) && outputOk(r)) return r; }
    }
    return null;
  }

  // ----------------------------------------------------------
  // AUTOCOMPLETE & CHEAT SHEET HELPERS
  // ----------------------------------------------------------

  const TYPE_LABEL = { shortcut: 'SHORTCUT', nl: 'PHRASE', gcode: 'G-CODE', mcode: 'M-CODE' };

  function getAutocompleteSuggestions(prefix) {
    if (!prefix || prefix.length < 2) return [];
    const p = prefix.toLowerCase();
    const seen = new Set(), results = [];
    for (const s of NL_SUGGESTIONS) {
      if (!isActive(s)) continue;
      if (s.code.toLowerCase().includes(p) || s.desc.toLowerCase().includes(p)) {
        if (!seen.has(s.code)) { seen.add(s.code); results.push(s); }
      }
    }
    for (const [c, d] of Object.entries(gTable())) {
      if (c.toLowerCase().includes(p) || d.toLowerCase().includes(p)) {
        if (!seen.has(c)) { seen.add(c); results.push({ code: c, desc: d, type: 'gcode' }); }
      }
    }
    for (const [c, d] of Object.entries(mTable())) {
      if (c.toLowerCase().includes(p) || d.toLowerCase().includes(p)) {
        if (!seen.has(c)) { seen.add(c); results.push({ code: c, desc: d, type: 'mcode' }); }
      }
    }
    return results.slice(0, 16);
  }

  function getCheatSheetItems() {
    const items = [];
    const quickSetupPatterns = [
      /^safety line/i, /^safety line inch/i, /^safety line metric/i,
      /^program header/i, /^home z/i, /^home all/i, /^tool change block/i,
      /^end block/i, /^part zero/i, /^clear z/i, /^wcs block/i, /^sub block/i,
      /^probe block/i, /^optional stop/i, /^mist on/i, /^tsc on/i,
      /^air blast on/i, /^conveyor on/i, /^quick tool change T##/i
    ];
    for (const sc of SHORTCUTS) {
      if (!isActive(sc)) continue;
      if (sc.hidden) continue;   // (listed with its #### placeholder under the phrases)
      const isQuick = quickSetupPatterns.some(p => p.test(sc.name));
      items.push({ code: sc.name, desc: sc.desc, category: 'Shortcut', isQuickSetup: isQuick });
    }
    for (const s of NL_SUGGESTIONS) {
      if (!isActive(s)) continue;
      const isQuick = quickSetupPatterns.some(p => p.test(s.code));
      items.push({ code: s.code, desc: s.desc, category: 'Natural Language', isQuickSetup: isQuick });
    }
    for (const [code, desc] of Object.entries(gTable())) {
      items.push({ code, desc, category: 'G-Code', isQuickSetup: false });
    }
    for (const [code, desc] of Object.entries(mTable())) {
      items.push({ code, desc, category: 'M-Code', isQuickSetup: false });
    }
    items.sort((a, b) => {
      if (a.isQuickSetup !== b.isQuickSetup) return a.isQuickSetup ? -1 : 1;
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.code.localeCompare(b.code);
    });
    return items;
  }

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------

  window.GcodeConverter = {
    detectUnits,
    applyUnitFormat,
    getLastMotionModal,
    tryConvertLine,
    getAutocompleteSuggestions,
    TYPE_LABEL,
    fmtNum,
    parseCoords,
    getCheatSheetItems,
    setMachine,
    getMachine,
    allowedAxisLetters,
  };

})();
