# Enigma decoder · DevFest Vibe Lounge

A web Enigma I that reads the lounge's machine from
`GET /api/enigma`, tunes in to `GET /api/transmissions` and decodes the
agenda as it goes on air.

- **Live:** the newest transmission is decoded letter by letter, with the
  rotors stepping as it goes.
- **On now · up next:** what's running in each room right now and what comes
  next, on Prague time wherever you open it. A talk runs until the next one in
  its room starts, capped at its stated length or 45 minutes.
- **Agenda:** every decoded talk lands in a timetable grouped by time slot,
  with the current and next talks flagged. The API only holds the last ten
  transmissions, so the browser keeps what it has heard and the timetable
  fills in as you listen.
- **Machine:** pick the rotor order, set the start, rings and plugboard, then
  type on your keyboard or tap the keys. Lamps light up, the signal path shows
  the letter after every stage, and the keys, lamps and rotors make sound
  (synthesised with Web Audio, with an on/off toggle). Any logged transmission
  can be replayed through it.

Nothing about the wiring is hard-coded: rotors, notches, reflector, rings and
plugs all come from the API, and the page checks itself against the API's
test vector on load.

Plain HTML, CSS and JavaScript with no build step. `enigma.js` is the engine,
`agenda.js` the timetable logic, `sound.js` the Web Audio sounds and `app.js`
the page.
