// Agenda helpers: turn decoded transmissions into talks and work out what is
// on now and up next. Plain functions, shared by the page and the tests.
(function (root) {
  'use strict';

  // The feed has start times only, so a talk without a stated length gets this.
  const DEFAULT_LENGTH = 45;

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

  function minutes(time) {
    const [h, m] = String(time).split(':').map(Number);
    return h * 60 + m;
  }

  function slotKey(talk) {
    return `${talk.time}|${talk.room}`;
  }

  // A talk runs until the next one in its room starts, and no longer than its
  // stated length ("… IN 90 MINUTES") or the default.
  function windows(talks) {
    const startsByRoom = new Map();
    for (const talk of talks) {
      if (!startsByRoom.has(talk.room)) startsByRoom.set(talk.room, []);
      startsByRoom.get(talk.room).push(minutes(talk.time));
    }
    return talks.map((talk) => {
      const start = minutes(talk.time);
      const later = startsByRoom.get(talk.room).filter((m) => m > start);
      const stated = /(\d{2,3})\s*MIN/.exec(talk.title || '');
      const length = stated ? Number(stated[1]) : DEFAULT_LENGTH;
      return { talk, start, end: Math.min(start + length, ...later) };
    });
  }

  // `now` is minutes since midnight on the event's clock. Returns the talks
  // running now, the next talk in each room, and every talk's state:
  // 'past', 'now', 'next' or 'later'.
  function schedule(talks, now) {
    const status = new Map();
    const onNow = [];
    const nextByRoom = new Map();
    for (const item of windows(talks)) {
      let state = 'later';
      if (item.end <= now) state = 'past';
      else if (item.start <= now) state = 'now';
      status.set(slotKey(item.talk), state);
      if (state === 'now') onNow.push(item);
      if (state === 'later') {
        const known = nextByRoom.get(item.talk.room);
        if (!known || item.start < known.start) nextByRoom.set(item.talk.room, item);
      }
    }
    const upNext = [...nextByRoom.values()]
      .sort((a, b) => a.start - b.start || a.talk.room.localeCompare(b.talk.room));
    upNext.forEach((item) => status.set(slotKey(item.talk), 'next'));
    onNow.sort((a, b) => a.talk.room.localeCompare(b.talk.room));
    return { onNow, upNext, status };
  }

  const api = { parseTalk, minutes, slotKey, schedule };
  root.VibeAgenda = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
