<p align="center">
  <img src="/icons/icon-192.png" width="100">
</p>

# SPEKTRE

A browser-based real-time spectrum analyzer for desktop and mobile. Plain HTML, CSS and JavaScript with no dependencies or build step.

**Live:** https://theogal.github.io/spektre/

## Screenshots
<p align="center">
  <img src="desktop-screenshot.png" width="100%">
  <img src="desktop-screenshot-spectrogram.png" width="100%">
</p>

### disclaimer
Im into web developing the last 10 years but this app was 100% vibe-coded with Claude - I simply inspected the code afterwards.

## Features

- **Sources:** select to analyze signal from an input device, browser tab or whole system using screen sharing or load a local audio/video file.
- **Calibrated dBFS:** a 0 dBFS sine reads 0 dB.
- **Precise peak readout:** interpolated peak frequency and level, with the note name and cents.
- **Display modes:** line, or 1/3, 1/6 and 1/12-octave bars, with optional peak hold.
- **Live stats:** RMS and sample-peak meters.
- **Resolution control:** FFT size from 2048 to 32768, with the bin resolution shown live.
- **Analysis options:** dB/oct slope, channel select (L+R, L or R), smoothing, display range, and freeze (Space).
- **Spectrogram:** an optional scrolling view under the main plot.
- **Cursor readout:** hover on desktop, or touch and drag on a phone.

### dB/oct slope setting

Music naturally carries far more energy in the low end, so a flat (unsloped) spectrum of a well-balanced mix falls steeply from left to right. That makes tonal balance hard to judge.

Tilting the display by 4.5 dB per octave (default setting) makes a balanced mix look roughly flat. It's the same convention as the default slope in Voxengo SPAN and other mixing analyzers, so readings in Spektre line up with what you're used to in a DAW.

The slope changes only the plot. The peak level and cursor readouts always show the true, unsloped dBFS. Choose 0, 3, 4.5 or 6 dB/oct in the settings.

### Defaults

The startup settings live in the `DEF` object at the top of `app.js`. Your last-used settings are saved in the browser and override them.

## How to host it

Simply download the files and place them on your server. 
Microphone and tab capture require HTTPS (or localhost).

**License** MIT - do whatever you like with it
