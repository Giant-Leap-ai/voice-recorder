# Voice recorder

A guided recording page for a speech research study. It walks a participant through short reading tasks in a normal voice, a whisper, a quiet voice and from across the room, one prompt at a time, then packages the recordings as a zip the participant sends themselves.

- Runs entirely in the browser. Nothing is uploaded by the page; recordings stay on the device until the participant shares the zip.
- Audio is captured uncompressed with the browser's echo cancellation, noise suppression and automatic gain control turned off where the browser allows it, and saved as 16 kHz WAV.
- Progress is saved on the device, so a reload resumes where it stopped.

Participants open the link they were given, which includes their ID (`?id=P07`). Add `&demo=1` to try the flow with synthetic audio instead of the microphone.

Code: MIT (see LICENSE).
