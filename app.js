// Vibe Lounge decoder: loads the machine from the lounge API, decodes every
// transmission as it airs, and keeps a playable Enigma on the page.
(function () {
  'use strict';

  const API = 'https://devfest-vibe-lounge.web.app/api';
  const EVENT_TZ = 'Europe/Prague';
  const POLL_MS = 10000;
  const CADENCE_MS = 60000;
  const LOG_SIZE = 30;
  const TAPE_TAIL = 240;
  const NEXT_LIMIT = 4;
  const STORE_KEY = 'vibe-enigma:agenda:v1';
  const SOUND_KEY = 'vibe-enigma:sound';
  const LAYOUT = ['QWERTZUIO', 'ASDFGHJK', 'PYXCVBNML'];
  const SLOTS = ['left', 'middle', 'right'];
  const FLAGS = { now: 'On now', next: 'Up next' };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const { parseTalk, minutes, slotKey, schedule } = window.VibeAgenda;
  const sound = window.VibeSound;
  const eventFormat = timeFormat();

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
  let lastMinute = -1;
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

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function timeFormat() {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: EVENT_TZ,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (err) {
      return null; // No time zone support: fall back to the device clock.
    }
  }

  // Hours, minutes and seconds on the event's clock, wherever the viewer is.
  function eventClock(date = new Date()) {
    if (!eventFormat) return [date.getHours(), date.getMinutes(), date.getSeconds()];
    const parts = {};
    for (const { type, value } of eventFormat.formatToParts(date)) parts[type] = Number(value);
    return [parts.hour, parts.minute, parts.second];
  }

  function clockTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const [h, m] = eventClock(date);
    return `${pad(h)}:${pad(m)}`;
  }

  function duration(mins) {
    const total = Math.round(mins);
    if (total < 60) return `${total} min`;
    const rest = total % 60;
    return rest ? `${Math.floor(total / 60)} h ${rest} min` : `${total / 60} h`;
  }

  async function getJson(path) {
    const response = await fetch(API + path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  // ---------- boot ----------

  async function start() {
    setupSound();
    tick();
    setInterval(tick, 1000);
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
      ['Rotors', spec.rotors.map((r) => r.name).join(' ')],
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

  function setupSound() {
    try {
      sound.enabled = localStorage.getItem(SOUND_KEY) !== 'off';
    } catch (err) {
      sound.enabled = true;
    }
    const toggle = $('sound-toggle');
    const render = () => {
      toggle.textContent = sound.enabled ? 'Sound on' : 'Sound off';
      toggle.setAttribute('aria-pressed', String(sound.enabled));
    };
    toggle.addEventListener('click', () => {
      sound.enabled = !sound.enabled;
      try {
        localStorage.setItem(SOUND_KEY, sound.enabled ? 'on' : 'off');
      } catch (err) {
        // Storage off: the choice lasts for this visit.
      }
      render();
      sound.ratchet();
    });
    render();
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
        refreshAgenda(booted ? arrived : []);
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
    const [h, m, s] = eventClock();
    $('clock').textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
    if (h * 60 + m !== lastMinute) {
      lastMinute = h * 60 + m;
      refreshAgenda([]);
    }

    const next = $('next');
    if (!signalOk) {
      next.textContent = 'Signal lost · retrying';
      return;
    }
    const sent = newest ? Date.parse(newest.sentAt) : NaN;
    if (Number.isNaN(sent)) return;
    const left = Math.min(60, Math.ceil((sent + CADENCE_MS - Date.now()) / 1000));
    if (left > 0) {
      next.textContent = `Next in ${Math.floor(left / 60)}:${pad(left % 60)}`;
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

  // Redraws everything that depends on the agenda or the time of day.
  function refreshAgenda(fresh) {
    const plan = schedule([...agenda.values()], lastMinute);
    renderNow(plan);
    renderAgenda(fresh, plan.status);
  }

  function renderNow(plan) {
    $('now-list').replaceChildren(...plan.onNow.map((item) => {
      const elapsed = lastMinute - item.start;
      return nowItem(item.talk, elapsed < 1 ? 'Just started' : `Since ${item.talk.time} · ${duration(elapsed)} in`);
    }));
    $('next-list').replaceChildren(...plan.upNext.slice(0, NEXT_LIMIT).map((item) => (
      nowItem(item.talk, `${item.talk.time} · in ${duration(item.start - lastMinute)}`)
    )));

    const heard = agenda.size;
    const nowEmpty = $('now-empty');
    nowEmpty.hidden = plan.onNow.length > 0;
    if (!heard) nowEmpty.textContent = 'Waiting for the first talks to be decoded.';
    else if (plan.upNext.length) nowEmpty.textContent = 'Nothing on right now, between sessions.';
    else nowEmpty.textContent = "That's a wrap for today.";
    const nextEmpty = $('next-empty');
    nextEmpty.hidden = plan.upNext.length > 0;
    nextEmpty.textContent = heard ? 'No more talks heard for today.' : 'Fills in as transmissions are decoded.';
  }

  function nowItem(talk, when) {
    const item = el('li', 'now-item');
    const head = el('div', 'talk-head');
    head.append(el('span', 'room', talk.room), el('span', 'now-when', when));
    item.append(head, el('h3', null, talk.title));
    if (talk.speakers) item.append(el('p', null, talk.speakers));
    return item;
  }

  function renderAgenda(fresh, status) {
    const freshKeys = new Set(fresh.map((t) => slotKey(t.talk)));
    const slots = new Map();
    for (const talk of agenda.values()) {
      if (!slots.has(talk.time)) slots.set(talk.time, []);
      slots.get(talk.time).push(talk);
    }

    const rows = [...slots.keys()]
      .sort((a, b) => minutes(a) - minutes(b))
      .map((time) => {
        const talks = slots.get(time).sort((a, b) => a.room.localeCompare(b.room));
        const states = talks.map((talk) => status.get(slotKey(talk)));
        const row = el('li', 'slot');
        row.classList.toggle('is-past', states.every((state) => state === 'past'));
        const list = el('ul', 'slot-talks');
        talks.forEach((talk, i) => list.append(agendaItem(talk, states[i], freshKeys.has(slotKey(talk)))));
        row.append(el('p', 'slot-time', time), list);
        return row;
      });

    $('agenda-list').replaceChildren(...rows);
    $('agenda-empty').hidden = agenda.size > 0;
    const rooms = new Set([...agenda.values()].map((talk) => talk.room));
    $('agenda-count').textContent = agenda.size
      ? `${plural(agenda.size, 'talk')} · ${plural(rooms.size, 'room')}`
      : '';
  }

  function agendaItem(talk, state, fresh) {
    const item = el('li', 'talk');
    if (state) item.classList.add(`is-${state}`);
    if (fresh) item.classList.add('is-fresh');
    const head = el('div', 'talk-head');
    head.append(el('span', 'room', talk.room));
    if (FLAGS[state]) head.append(el('span', `flag flag-${state}`, FLAGS[state]));
    item.append(head, el('h3', null, talk.title));
    if (talk.speakers) item.append(el('p', null, talk.speakers));
    return item;
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
    const rotors = SLOTS.map((slotName, slot) => {
      const rotor = el('div', 'rotor');
      const win = el('output', 'rotor-window');
      win.id = `rotor-${slot}`;
      win.setAttribute('aria-label', `${slotName} rotor position`);
      const name = el('span', 'rotor-name');
      name.id = `rotor-name-${slot}`;
      const notch = el('span', 'rotor-notch');
      notch.id = `rotor-notch-${slot}`;
      rotor.append(
        machineButton('rotor-btn', '▲', `Turn the ${slotName} rotor forward`, () => turn(slot, 1)),
        win,
        machineButton('rotor-btn', '▼', `Turn the ${slotName} rotor back`, () => turn(slot, -1)),
        name,
        notch,
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

    // Key, plug, three rotors, reflector, three rotors back, plug. The labels
    // follow the rotor order, so renderRotorLabels fills them in.
    $('path').replaceChildren(...Array.from({ length: 10 }, () => {
      const stage = el('div', 'stage');
      stage.append(el('span', 'stage-label'), el('span', 'stage-letter', '·'));
      return stage;
    }));

    SLOTS.forEach((slotName, slot) => {
      const select = $(`set-order-${slot}`);
      select.replaceChildren(...machine.availableRotors.map((name) => {
        const option = el('option', null, name);
        option.value = name;
        return option;
      }));
      select.addEventListener('change', () => chooseRotor(slot, select.value));
    });

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
      sound.ratchet();
      note('Set to the broadcast key');
    });
    $('message-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = $('set-message').value;
      if (!text.trim()) return;
      note(`Running your text from ${machine.getPositions()}`);
      feed(text, reduceMotion ? 0 : 30);
    });

    renderRotorLabels();
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

  // `soft` is for playback, where letters come too fast for full sound.
  function press(letter, soft = false) {
    undo.push(machine.getPositions());
    const result = machine.press(letter);
    tapeIn += letter;
    tapeOut += result.output;
    syncWindows();
    lightLamp(result.output);
    showPath(result.path);
    flashKey(letter);
    renderTape();
    sound.key(soft ? 0.35 : 1);
    sound.lamp(result.output, soft);
  }

  function passThrough(ch, soft = false) {
    undo.push(machine.getPositions());
    tapeIn += ch;
    tapeOut += ch;
    renderTape();
    if (!soft) sound.key(0.6);
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
    sound.ratchet();
  }

  function rewind() {
    stopPlayback();
    machine.setPositions(tapeStart);
    resetTape();
    sound.ratchet();
    note(`Rewound to ${tapeStart}`);
  }

  function turn(slot, delta) {
    stopPlayback();
    const letters = machine.getPositions().split('');
    const { alphabet } = machine;
    letters[slot] = alphabet[(alphabet.indexOf(letters[slot]) + delta + alphabet.length) % alphabet.length];
    machine.setPositions(letters.join(''));
    resetTape();
    sound.ratchet();
  }

  // Putting a rotor into a slot swaps it with the one already there, the way
  // you'd lift the rotors out and reorder them on the spindle.
  function chooseRotor(slot, name) {
    const order = machine.rotorNames;
    const from = order.indexOf(name);
    if (from === -1 || from === slot) return;
    [order[slot], order[from]] = [order[from], order[slot]];
    stopPlayback();
    machine.setRotorOrder(order);
    renderRotorLabels();
    resetTape();
    sound.ratchet();
    note(`Rotor order ${order.join(' · ')}`);
  }

  function renderRotorLabels() {
    const names = machine.rotorNames;
    const { notches } = machine;
    names.forEach((name, slot) => {
      $(`rotor-name-${slot}`).textContent = name;
      $(`rotor-notch-${slot}`).textContent = `notch ${notches[slot]}`;
      $(`set-order-${slot}`).value = name;
    });
    const stages = ['Key', 'Plug', ...[...names].reverse(), 'UKW', ...names, 'Plug'];
    $('path').querySelectorAll('.stage-label').forEach((label, i) => {
      label.textContent = stages[i];
    });
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
    machine.setRotorOrder(spec.rotors.map((r) => r.name));
    machine.setRings(spec.rings || 'AAA');
    machine.setPlugboard(spec.plugboard || []);
    renderRotorLabels();
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
      if (machine.isLetter(ch)) press(ch.toUpperCase(), true);
      else passThrough(ch, true);
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
