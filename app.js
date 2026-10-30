// Vibe Lounge decoder: loads the machine from the lounge API, decodes every
// transmission as it airs, and keeps a playable Enigma on the page.
(function () {
  'use strict';

  const API = 'https://devfest-vibe-lounge.web.app/api';
  const POLL_MS = 10000;
  const CADENCE_MS = 60000;
  const LOG_SIZE = 30;
  const TAPE_TAIL = 240;
  const STORE_KEY = 'vibe-enigma:agenda:v1';
  const LAYOUT = ['QWERTZUIO', 'ASDFGHJK', 'PYXCVBNML'];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let spec = null;
  let decoder = null; // decodes transmissions; the page never touches it
  let machine = null; // the machine on screen
  let newest = null;
  let signalOk = true;
  let polling = false;
  let booted = false;
  let liveToken = 0;
  let playToken = 0;
  let litLamp = null;
  let tapeIn = '';
  let tapeOut = '';
  let tapeStart = 'AAA';
  const undo = []; // rotor positions before each tape character
  const transmissions = new Map();
  const agenda = loadAgenda();

  start();

  // ---------- helpers ----------

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  function minutes(time) {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }

  function clockTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  async function getJson(path) {
    const response = await fetch(API + path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // "10:50 SPEAKEASY: TITLE: SUBTITLE / SPEAKER, SPEAKER"
  function parseTalk(plain) {
    const match = /^(\d{1,2}:\d{2})\s+([^:]+?):\s*(.*)$/.exec(plain || '');
    if (!match) return { time: '', room: '', title: plain || '', speakers: '' };
    const [, time, room, rest] = match;
    const cut = rest.lastIndexOf(' / ');
    return cut === -1
      ? { time, room, title: rest, speakers: '' }
      : { time, room, title: rest.slice(0, cut), speakers: rest.slice(cut + 3) };
  }

  // ---------- boot ----------

  async function start() {
    tick();
    setInterval(tick, 1000);
    renderAgenda([]);
    renderLog();
    showSource();

    while (!spec) {
      try {
        const loaded = await getJson('/enigma');
        decoder = Enigma.createMachine(loaded);
        machine = Enigma.createMachine(loaded);
        spec = loaded;
      } catch (err) {
        renderSpecError(err);
        await sleep(5000);
      }
    }

    renderSpec();
    buildMachine();
    await poll();
    setInterval(poll, POLL_MS);
  }

  function renderSpecError(err) {
    const item = el('li', 'is-bad', `Can't reach the machine (${err.message}). Retrying…`);
    $('spec').replaceChildren(item);
  }

  function renderSpec() {
    const facts = [
      ['Machine', spec.machine || 'Enigma'],
      ['Rotors', machine.rotorNames.join(' ')],
      ['UKW', machine.reflectorName],
      ['Rings', machine.getRings()],
      ['Plugs', machine.getPlugboardPairs().join(' ') || 'none'],
    ];
    const items = facts.map(([label, value]) => {
      const item = el('li');
      item.append(el('span', 'spec-label', label), value);
      return item;
    });

    const vector = spec.testVector;
    if (vector) {
      const check = Enigma.createMachine(spec);
      const passed = check.run(vector.plaintext, vector.start) === vector.ciphertext
        && check.run(vector.ciphertext, vector.start) === vector.plaintext;
      const item = el('li', passed ? 'is-ok' : 'is-bad');
      item.append(el('span', 'spec-label', 'Test vector'), passed ? 'pass ✓' : 'fail');
      item.title = `${vector.plaintext} → ${vector.ciphertext} from ${vector.start}`;
      items.push(item);
    }
    $('spec').replaceChildren(...items);
  }

  function showSource() {
    const { hostname, pathname } = window.location;
    const repo = pathname.split('/').filter(Boolean)[0];
    if (!hostname.endsWith('.github.io') || !repo) return;
    const link = el('a', null, 'Source on GitHub');
    link.href = `https://github.com/${hostname.replace('.github.io', '')}/${repo}`;
    $('source').append(link);
  }

  // ---------- transmissions ----------

  async function poll() {
    if (polling || !spec) return;
    polling = true;
    try {
      const data = await getJson('/transmissions');
      const arrived = (data.transmissions || [])
        .filter((t) => t && Number.isFinite(t.number) && !transmissions.has(t.number))
        .sort((a, b) => a.number - b.number)
        .map(decode);
      arrived.forEach((t) => {
        transmissions.set(t.number, t);
        remember(t);
      });
      setSignal(true);

      if (arrived.length) {
        trimLog();
        saveAgenda();
        renderAgenda(booted ? arrived : []);
        renderLog();
        const latest = arrived[arrived.length - 1];
        if (!newest || latest.number > newest.number) {
          newest = latest;
          showLive(latest);
        }
      }
      booted = true;
    } catch (err) {
      setSignal(false);
    } finally {
      polling = false;
    }
  }

  function decode(t) {
    let plaintext = '';
    try {
      plaintext = decoder.run(t.ciphertext || '', t.start);
    } catch (err) {
      plaintext = '';
    }
    return { ...t, plaintext, talk: parseTalk(plaintext) };
  }

  function trimLog() {
    const keep = new Set([...transmissions.keys()].sort((a, b) => b - a).slice(0, LOG_SIZE));
    for (const number of [...transmissions.keys()]) {
      if (!keep.has(number)) transmissions.delete(number);
    }
  }

  function setSignal(ok) {
    signalOk = ok;
    $('signal-dot').classList.toggle('is-off', !ok);
    tick();
  }

  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const next = $('next');
    if (!signalOk) {
      next.textContent = 'Signal lost · retrying';
      return;
    }
    const sent = newest ? Date.parse(newest.sentAt) : NaN;
    if (Number.isNaN(sent)) return;
    const left = Math.min(60, Math.ceil((sent + CADENCE_MS - Date.now()) / 1000));
    if (left > 0) {
      next.textContent = `Next in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    } else {
      next.textContent = 'Next any second';
      if (left > -120 && -left % 3 === 0) poll();
    }
  }

  async function showLive(t) {
    const token = ++liveToken;
    const plain = $('live-plain');
    const rotors = $('live-rotors');
    const label = $('live-rotors-label');
    $('live-number').textContent = t.number;
    $('live-cipher').textContent = t.ciphertext;
    $('live-talk').hidden = true;

    if (!t.plaintext) {
      plain.textContent = "Couldn't decode this one.";
      setWindows(rotors, t.start || '···');
      return;
    }

    if (!reduceMotion) {
      label.textContent = 'Rotors';
      for (const frame of frames(t)) {
        if (token !== liveToken) return;
        plain.textContent = frame.text;
        setWindows(rotors, frame.rotors);
        await sleep(frame.letter ? 22 : 8);
      }
      if (token !== liveToken) return;
    }

    plain.textContent = t.plaintext;
    setWindows(rotors, t.start);
    label.textContent = 'Rotor start';
    $('live-time').textContent = t.talk.time;
    $('live-room').textContent = t.talk.room;
    $('live-room').hidden = !t.talk.room;
    $('live-title').textContent = t.talk.title;
    $('live-speakers').textContent = t.talk.speakers;
    $('live-talk').hidden = false;
  }

  // The decode, one character at a time, with the rotors after each step.
  function frames(t) {
    const replay = Enigma.createMachine(spec);
    replay.setPositions(t.start);
    const out = [];
    let text = '';
    for (const ch of t.ciphertext) {
      const letter = replay.isLetter(ch);
      text += letter ? replay.press(ch.toUpperCase()).output : ch;
      out.push({ text, rotors: replay.getPositions(), letter });
    }
    return out;
  }

  function setWindows(container, letters) {
    [...container.children].forEach((span, i) => {
      span.textContent = letters[i] || '·';
    });
  }

  function miniWindows(letters) {
    const box = el('span', 'mini');
    box.setAttribute('aria-label', `Rotor start ${letters}`);
    for (const ch of letters || '') box.append(el('span', null, ch));
    return box;
  }

  // ---------- agenda ----------

  function slotKey(talk) {
    return `${talk.time}|${talk.room}`;
  }

  function loadAgenda() {
    try {
      const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return new Map(list.filter((x) => x && x.time && x.room && x.title).map((x) => [slotKey(x), x]));
    } catch (err) {
      return new Map();
    }
  }

  function saveAgenda() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...agenda.values()]));
    } catch (err) {
      // Private mode or storage off: the agenda just lives for this visit.
    }
  }

  function remember(t) {
    const { time, room, title, speakers } = t.talk;
    if (!time || !room) return;
    const known = agenda.get(slotKey(t.talk));
    if (known && Date.parse(known.sentAt) >= Date.parse(t.sentAt)) return;
    agenda.set(slotKey(t.talk), { time, room, title, speakers, sentAt: t.sentAt });
  }

  function renderAgenda(fresh) {
    const freshKeys = new Set(fresh.map((t) => slotKey(t.talk)));
    const slots = new Map();
    for (const talk of agenda.values()) {
      if (!slots.has(talk.time)) slots.set(talk.time, []);
      slots.get(talk.time).push(talk);
    }

    const rows = [...slots.keys()]
      .sort((a, b) => minutes(a) - minutes(b))
      .map((time) => {
        const row = el('li', 'slot');
        const talks = el('ul', 'slot-talks');
        for (const talk of slots.get(time).sort((a, b) => a.room.localeCompare(b.room))) {
          const item = el('li', 'talk');
          if (freshKeys.has(slotKey(talk))) item.classList.add('is-fresh');
          item.append(el('span', 'room', talk.room), el('h3', null, talk.title));
          if (talk.speakers) item.append(el('p', null, talk.speakers));
          talks.append(item);
        }
        row.append(el('p', 'slot-time', time), talks);
        return row;
      });

    $('agenda-list').replaceChildren(...rows);
    $('agenda-empty').hidden = agenda.size > 0;
    const rooms = new Set([...agenda.values()].map((talk) => talk.room));
    $('agenda-count').textContent = agenda.size
      ? `${plural(agenda.size, 'talk')} · ${plural(rooms.size, 'room')}`
      : '';
  }

  // ---------- intercept log ----------

  function renderLog() {
    const items = [...transmissions.values()]
      .sort((a, b) => b.number - a.number)
      .map((t) => {
        const item = el('li', 'entry');
        const head = el('div', 'entry-head');
        const time = el('time', 'entry-time', clockTime(t.sentAt));
        time.dateTime = t.sentAt || '';
        head.append(el('span', null, `N° ${t.number}`), miniWindows(t.start), time);
        const run = el('button', 'btn', 'Run it through the machine');
        run.type = 'button';
        run.addEventListener('click', () => playTransmission(t));
        item.append(
          head,
          el('p', 'entry-cipher', t.ciphertext),
          el('p', 'entry-plain', t.plaintext || "Couldn't decode this one."),
          run,
        );
        return item;
      });
    $('log-list').replaceChildren(...items);
    $('log-empty').hidden = items.length > 0;
  }

  // ---------- the machine ----------

  function buildMachine() {
    const ukw = el('div', 'ukw');
    ukw.append('UKW', el('strong', null, machine.reflectorName));
    const rotors = machine.rotorNames.map((name, slot) => {
      const rotor = el('div', 'rotor');
      const win = el('output', 'rotor-window');
      win.id = `rotor-${slot}`;
      win.setAttribute('aria-label', `Rotor ${name} position`);
      rotor.append(
        machineButton('rotor-btn', '▲', `Turn rotor ${name} forward`, () => turn(slot, 1)),
        win,
        machineButton('rotor-btn', '▼', `Turn rotor ${name} back`, () => turn(slot, -1)),
        el('span', 'rotor-name', name),
        el('span', 'rotor-notch', `notch ${machine.notches[slot]}`),
      );
      return rotor;
    });
    $('rotors').replaceChildren(ukw, ...rotors);

    for (const letters of LAYOUT) {
      const lampRow = el('div', 'row');
      const keyRow = el('div', 'row');
      for (const letter of letters) {
        const lamp = el('span', 'lamp', letter);
        lamp.id = `lamp-${letter}`;
        lampRow.append(lamp);
        const key = machineButton('key', letter, `Key ${letter}`, () => typeLetter(letter));
        key.id = `key-${letter}`;
        key.tabIndex = -1;
        keyRow.append(key);
      }
      $('lamps').append(lampRow);
      $('keys').append(keyRow);
    }

    const names = machine.rotorNames;
    const stages = ['Key', 'Plug', ...[...names].reverse(), 'UKW', ...names, 'Plug'];
    $('path').replaceChildren(...stages.map((label) => {
      const stage = el('div', 'stage');
      stage.append(el('span', 'stage-label', label), el('span', 'stage-letter', '·'));
      return stage;
    }));

    $('machine-card').addEventListener('keydown', onKeyDown);
    keepFocus($('key-space'));
    keepFocus($('key-erase'));
    keepFocus($('key-rewind'));
    $('key-space').addEventListener('click', () => {
      stopPlayback();
      passThrough(' ');
    });
    $('key-erase').addEventListener('click', erase);
    $('key-rewind').addEventListener('click', rewind);

    bindSetting('set-start', (value) => machine.setPositions(value));
    bindSetting('set-rings', (value) => machine.setRings(value));
    bindSetting('set-plugs', (value) => machine.setPlugboard(value));
    $('reset-key').addEventListener('click', () => {
      stopPlayback();
      applyBroadcastKey();
      machine.setPositions('AAA');
      resetTape();
      note('Set to the broadcast key');
    });
    $('message-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = $('set-message').value;
      if (!text.trim()) return;
      note(`Running your text from ${machine.getPositions()}`);
      feed(text, reduceMotion ? 0 : 30);
    });

    resetTape();
  }

  function machineButton(className, label, ariaLabel, onPress) {
    const button = el('button', className, label);
    button.type = 'button';
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', onPress);
    keepFocus(button);
    return button;
  }

  // Mouse clicks on the machine's buttons leave focus on the machine, so the
  // physical keyboard keeps typing into it.
  function keepFocus(button) {
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse') return;
      event.preventDefault();
      $('machine-card').focus({ preventScroll: true });
    });
  }

  function onKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (/^[a-z]$/i.test(event.key)) {
      event.preventDefault();
      typeLetter(event.key.toUpperCase());
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      erase();
    } else if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      stopPlayback();
      passThrough(' ');
    }
  }

  function typeLetter(letter) {
    stopPlayback();
    press(letter);
  }

  function press(letter) {
    undo.push(machine.getPositions());
    const result = machine.press(letter);
    tapeIn += letter;
    tapeOut += result.output;
    syncWindows();
    lightLamp(result.output);
    showPath(result.path);
    flashKey(letter);
    renderTape();
  }

  function passThrough(ch) {
    undo.push(machine.getPositions());
    tapeIn += ch;
    tapeOut += ch;
    renderTape();
  }

  function erase() {
    stopPlayback();
    if (!undo.length) return;
    machine.setPositions(undo.pop());
    tapeIn = tapeIn.slice(0, -1);
    tapeOut = tapeOut.slice(0, -1);
    syncWindows();
    lightLamp(null);
    renderTape();
  }

  function rewind() {
    stopPlayback();
    machine.setPositions(tapeStart);
    resetTape();
    note(`Rewound to ${tapeStart}`);
  }

  function turn(slot, delta) {
    stopPlayback();
    const letters = machine.getPositions().split('');
    const { alphabet } = machine;
    letters[slot] = alphabet[(alphabet.indexOf(letters[slot]) + delta + alphabet.length) % alphabet.length];
    machine.setPositions(letters.join(''));
    resetTape();
  }

  // A new message starts wherever the rotors are now.
  function resetTape() {
    tapeIn = '';
    tapeOut = '';
    undo.length = 0;
    tapeStart = machine.getPositions();
    syncWindows();
    lightLamp(null);
    showPath(null);
    renderTape();
  }

  function applyBroadcastKey() {
    machine.setRings(spec.rings || 'AAA');
    machine.setPlugboard(spec.plugboard || []);
    for (const id of ['set-start', 'set-rings', 'set-plugs']) $(id).removeAttribute('aria-invalid');
    $('settings-error').textContent = '';
  }

  async function playTransmission(t) {
    applyBroadcastKey();
    machine.setPositions(t.start);
    resetTape();
    note(`N° ${t.number} from ${t.start}`);
    const card = $('machine-card').getBoundingClientRect();
    if (card.top < 0 || card.bottom > window.innerHeight) {
      $('machine').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
    await feed(t.ciphertext, reduceMotion ? 0 : 40);
  }

  async function feed(text, delay) {
    const token = ++playToken;
    if (delay) await sleep(300);
    for (const ch of text) {
      if (token !== playToken) return;
      if (machine.isLetter(ch)) press(ch.toUpperCase());
      else passThrough(ch);
      if (delay) await sleep(machine.isLetter(ch) ? delay : delay / 4);
    }
  }

  function stopPlayback() {
    playToken += 1;
  }

  function bindSetting(id, applyValue) {
    const input = $(id);
    const attempt = (showError) => {
      try {
        applyValue(input.value);
      } catch (err) {
        if (showError) {
          input.setAttribute('aria-invalid', 'true');
          $('settings-error').textContent = err.message;
        }
        return;
      }
      input.removeAttribute('aria-invalid');
      $('settings-error').textContent = '';
      stopPlayback();
      resetTape();
    };
    input.addEventListener('input', () => attempt(false));
    input.addEventListener('change', () => attempt(true));
  }

  function syncWindows() {
    const positions = machine.getPositions();
    [...positions].forEach((letter, slot) => {
      $(`rotor-${slot}`).textContent = letter;
    });
    const fields = { 'set-start': positions, 'set-rings': machine.getRings(), 'set-plugs': machine.getPlugboardPairs().join(' ') };
    for (const [id, value] of Object.entries(fields)) {
      const input = $(id);
      if (document.activeElement !== input && !input.hasAttribute('aria-invalid')) input.value = value;
    }
  }

  function lightLamp(letter) {
    if (litLamp) litLamp.classList.remove('is-lit');
    litLamp = letter ? $(`lamp-${letter}`) : null;
    if (litLamp) litLamp.classList.add('is-lit');
  }

  function flashKey(letter) {
    const key = $(`key-${letter}`);
    if (!key) return;
    key.classList.add('is-down');
    setTimeout(() => key.classList.remove('is-down'), 110);
  }

  function showPath(path) {
    const letters = $('path').querySelectorAll('.stage-letter');
    letters.forEach((cell, i) => {
      cell.textContent = path ? path[i] : '·';
    });
    $('path').classList.toggle('is-live', Boolean(path));
  }

  function renderTape() {
    const tail = (s) => (s.length > TAPE_TAIL ? `…${s.slice(-TAPE_TAIL)}` : s);
    $('tape-in').textContent = tail(tapeIn);
    $('tape-out').textContent = tail(tapeOut);
    const rewindButton = $('key-rewind');
    rewindButton.textContent = `Rewind to ${tapeStart}`;
    rewindButton.disabled = !tapeIn;
    $('key-erase').disabled = !undo.length;
  }

  function note(text) {
    $('machine-note').textContent = text;
  }
})();
