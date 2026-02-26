# AliveDrive PDR 2.5 Telemetry Format

Reverse-engineered from the `adco` data track in MP4 files produced by the
AliveDrive / Cosworth Performance Data Recorder found in the 2025-2026 Cadillac
CT5-V Blackwing (and likely other GM vehicles with the PDR 2.5 hardware).

This document covers the **AliveDrive PDR 2.5** format, which is distinct from
the older **Marlin** format (handler `ctbx`, codec `mrld`/`mrlv`/`marl`) used
in Corvette C7/C8 PDR systems.

---

## 1. MP4 Container Layout

The MP4 file contains four streams:

| Stream | Type | Details |
|--------|------|---------|
| 0 | H.264 video | 1920x1080 @ ~30 fps |
| 1 | AliveDrive data | handler `adrv`, codec `adco` |
| 2 | AAC audio | stereo, 48 kHz |
| 3 | MJPEG | thumbnail / poster frame |

### 1.1 Identifying the Data Track

Inside `moov/trak/mdia/hdlr`, look for `handler_type == "adrv"`.
Alternatively, inside `moov/trak/mdia/minf/stbl/stsd`, the first sample entry
will have codec tag `adco`.

The `hdlr` name string is `"AliveDrive PDR 2.5"`.

### 1.2 Custom Sub-Boxes Inside `adco`

The `adco` sample description entry (inside `stsd`) contains these nested boxes:

| Box | Purpose |
|------|---------|
| `advi` | Version / identifier info |
| `adop` | Outing properties (track name, vehicle, GPS bounding box, etc.) |
| `adcp` | Channel parameter definitions (59 channels) |
| `adcr` | Rate table — defines rate groups, periods, and channel assignments |
| `adud` | User-defined metadata |
| `adeg` | Engine / vehicle configuration |

---

## 2. Channel Definitions (`adcp`)

59 channels are defined, numbered 0–58. Names were recovered from string data
in the `adcp` box and correlated with decoded values.

| Ch | Name | Rate Group | Unit / Notes |
|----|------|-----------|--------------|
| 0 | internal | 2 (10 Hz) | Internal counter |
| 1 | speed | 2 (10 Hz) | Vehicle speed (see scale factors) |
| 2 | gps.latitude | 2 (10 Hz) | Radians-encoded (see GPS section) |
| 3 | gps.longitude | 2 (10 Hz) | Radians-encoded |
| 4 | gps.altitude | 2 (10 Hz) | Millimetres |
| 5 | gps.heading | 2 (10 Hz) | Radians |
| 6 | gps.fixquality | 2 (10 Hz) | 3 = PPS fix |
| 7 | gps.satellites | 2 (10 Hz) | Count (typically 14) |
| 8 | abs | 1 (50 Hz) | ABS status |
| 9 | accel.lateral.max | 1 (50 Hz) | g, IEEE 754 float32 |
| 10 | accel.lateral.min | 1 (50 Hz) | g, IEEE 754 float32 |
| 11 | accel.longitudinal.max | 1 (50 Hz) | g, IEEE 754 float32 |
| 12 | accel.longitudinal.min | 1 (50 Hz) | g, IEEE 754 float32 |
| 13 | accel.vertical | 1 (50 Hz) | g, IEEE 754 float32 |
| 14 | accel.z | 2 (10 Hz) | g, IEEE 754 float32 |
| 16 | motor.powerlevel | 0 (100 Hz) | 1 byte |
| 17 | brake | 3 (5 Hz) | Brake status |
| 18 | engine.coolant.temp | 2 (10 Hz) | Raw u16 |
| 20 | tire.fl.pressure | 2 (10 Hz) | Raw u16 |
| 24 | boost | 2 (10 Hz) | Raw u16 |
| 26 | oil.pressure | 4 (2 Hz) | 1 byte |
| 29 | engine.speed | 0 (100 Hz) | Radians/s (see scale factors) |
| 30 | engine.startstop | 3 (5 Hz) | 1 byte |
| 31 | engine.torque | 0 (100 Hz) | Raw u16 |
| 33 | esc.status | 3 (5 Hz) | 1 byte |
| 40 | emotor.power | 2 (10 Hz) | Raw u16 |
| 41 | engine.power | 2 (10 Hz) | Raw u16 |
| 42 | steering.angle | 0 (100 Hz) | Radians (see scale factors) |
| 43 | tcs.status | 3 (5 Hz) | 1 byte |
| 54 | wheel.speed.fl | 0 (100 Hz) | Raw u16 |
| 55 | wheel.speed.fr | 0 (100 Hz) | Raw u16 |
| 56 | wheel.speed.rl | 0 (100 Hz) | Raw u16 |
| 57 | wheel.speed.rr | 0 (100 Hz) | Raw u16 |
| 58 | gyro.yaw | 0 (100 Hz) | Raw i16 |

Channels 15, 19, 21–23, 25, 27–28, 32, 34–39, 44–53 are present in the 1 Hz
group (group 5) and include tyre temps, tyre IDs, VIN, odometer, ambient temp,
battery voltage, transmission temp, etc. The 1 Hz frame is 31 bytes; full
mapping of these fields is not yet complete.

---

## 3. Rate Table (`adcr`)

### 3.1 Header

```
Offset  Size  Field
0       1     version (0)
1       1     flags
2       1     num_groups (6)
3       1     padding
```

### 3.2 Per-Group Structure

For each of `num_groups` groups:

```
Offset  Size  Field
0       3     padding bytes
3       4     period (big-endian u32, in 100 ns ticks)
7       2     num_channels (big-endian u16)
9       N×3   channel entries: ch_id (u16 BE) + width (u8)
```

### 3.3 Rate Groups

| Group | Period (100 ns ticks) | Frequency | Channels | Rate-Table Width | Actual Width |
|-------|----------------------|-----------|----------|-----------------|--------------|
| 0 | 100,000 | 100 Hz | 9 | 32 bytes | **17 bytes** |
| 1 | 200,000 | 50 Hz | 6 | 54 bytes | **24 bytes** |
| 2 | 1,000,000 | 10 Hz | 12 | 44 bytes | **28 bytes** |
| 3 | 2,000,000 | 5 Hz | 4 | 8 bytes | **4 bytes** |
| 4 | 5,000,000 | 2 Hz | 1 | 2 bytes | **1 byte** |
| 5 | 10,000,000 | 1 Hz | 27 | 59 bytes | **31 bytes** |

> **Critical finding:** The `width` values in the rate table do NOT represent
> the actual byte count stored in the data stream. The rate-table widths appear
> to include per-channel quality/validity bytes that are not written to the
> data. The actual stored width is approximately `rate_table_width / 2`, rounded
> to the storage sizes shown above.

### 3.4 Group 0 Channels (100 Hz, 17 bytes actual)

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 16 | motor.powerlevel | 2 | 1 |
| 29 | engine.speed | 4 | 2 |
| 31 | engine.torque | 4 | 2 |
| 42 | steering.angle | 3 | 2 |
| 54 | wheel.speed.fl | 4 | 2 |
| 55 | wheel.speed.fr | 4 | 2 |
| 56 | wheel.speed.rl | 4 | 2 |
| 57 | wheel.speed.rr | 4 | 2 |
| 58 | gyro.yaw | 3 | 2 |

### 3.5 Group 1 Channels (50 Hz, 24 bytes actual)

Six channels, each stored as an IEEE 754 big-endian float32 (4 bytes):

| Ch | Name | Rate-Table Width | Actual Bytes |
|----|------|-----------------|--------------|
| 8 | abs | 9 | 4 |
| 9 | accel.lateral.max | 9 | 4 |
| 10 | accel.lateral.min | 9 | 4 |
| 11 | accel.longitudinal.max | 9 | 4 |
| 12 | accel.longitudinal.min | 9 | 4 |
| 13 | accel.vertical | 9 | 4 |

### 3.6 Group 2 Channels (10 Hz, 28 bytes actual)

The 28-byte frame includes 2 bytes of speed *before* the lat position, then
26 bytes starting at lat:

| Ch | Name | Actual Bytes | Encoding |
|----|------|-------------|----------|
| 1 | speed | 2 | u16 BE |
| 2 | gps.latitude | 4 | i32 BE |
| 3 | gps.longitude | 4 | i32 BE |
| 4 | gps.altitude | 4 | u32 BE |
| 5 | gps.heading | 2 | u16 BE |
| 0 | internal | 2 | u16 BE |
| 6 | gps.fixquality | 1 | u8 |
| 7 | gps.satellites | 1 | u8 |
| 18 | engine.coolant.temp | 2 | u16 BE |
| 20 | tire.fl.pressure | 2 | u16 BE |
| 40 | emotor.power | 2 | u16 BE |
| 41 | engine.power | 2 | u16 BE |

### 3.7 Group 3 Channels (5 Hz, 4 bytes actual)

| Ch | Name | Actual Bytes | Encoding |
|----|------|-------------|----------|
| 17 | brake | 1 | u8 |
| 30 | engine.startstop | 1 | u8 |
| 33 | esc.status | 1 | u8 |
| 43 | tcs.status | 1 | u8 |

### 3.8 Group 4 Channel (2 Hz, 1 byte actual)

| Ch | Name | Actual Bytes | Encoding |
|----|------|-------------|----------|
| 26 | oil.pressure | 1 | u8 |

### 3.9 Group 5 Channels (1 Hz, 31 bytes actual)

27 channels packed into 31 bytes. Includes tyre temps, tyre IDs, VIN data,
odometer, ambient temp, battery voltage, transmission temp, fuel level, tyre
pressures (RL/RR/spare), and spare tyre temp. Exact byte-level mapping is
incomplete.

---

## 4. Packet Structure

### 4.1 Sample Table

The data track's sample table (`stsz`) typically contains:

- 1 init sample of 14 bytes
- ~660 data samples, mostly 3247 bytes each (some slightly larger)

Each data sample represents **1 second** of telemetry.

### 4.2 Init Packet (14 bytes)

The first sample is a 14-byte initialisation packet. Its internal structure is
not fully decoded but likely contains a format version and timing reference.

### 4.3 Data Packet (3247 bytes, nominal)

Each data packet contains 1 second of time-interleaved multi-rate data
organised into **10 frames** (one per 100 ms GPS epoch).

### 4.4 Frame Interleaving Pattern

Within each 1-second packet, data is interleaved as follows. The pattern
repeats 10 times (once per 10 Hz GPS reading):

```
For frame_idx in 0..9:

  [Group 2: 10 Hz base]           28 bytes (2 speed + 26 GPS/vehicle)
  [Group 3: 5 Hz, if even frame]   4 bytes (frames 0, 2, 4, 6, 8)
  [Group 4: 2 Hz, if frame 0 or 5] 1 byte
  [Group 5: 1 Hz, if frame 0]     31 bytes

  Repeated 5 times:
    [Group 0: 100 Hz sub-frame]   17 bytes
    [Group 0: 100 Hz sub-frame]   17 bytes
    [Group 1: 50 Hz sub-frame]    24 bytes
```

This gives 10 × 100 Hz readings per frame (10 frames × 10 = 100 per second),
10 × 5 = 50 Hz readings per frame, and the base 10 Hz / 5 Hz / 2 Hz / 1 Hz
at their respective rates.

### 4.5 Byte Budget Verification

Per 1-second packet:
```
10 Hz base:   10 × 28  = 280
5 Hz data:     5 × 4   =  20
2 Hz data:     2 × 1   =   2
1 Hz data:     1 × 31  =  31
100 Hz frames: 100 × 17 = 1700
50 Hz frames:  50 × 24  = 1200
                         ------
Total:                    3233
```

The remaining ~14 bytes (3247 - 3233) account for a small preamble containing
partial 100 Hz / 50 Hz sub-frames carried over from the previous second's
timing boundary.

### 4.6 GPS Offset Variability

GPS latitude offsets within a packet are **not** at fixed byte positions. They
shift from packet to packet due to the variable-length preamble. Offsets
observed range from ~57 to ~290 bytes from the packet start.

To locate GPS data, scan for the byte pattern of a known latitude in the
expected range (e.g., `0x15 0x8F xxxx` for ~36° N), then validate with
longitude, altitude, and clustering checks.

---

## 5. Scale Factors

All multi-byte integers are **big-endian**.

| Channel | Raw Type | Scale | Resulting Unit |
|---------|----------|-------|---------------|
| gps.latitude | i32 BE | × 1.7453293e-09 × (180/π) ≈ × 1.0e-07 | degrees |
| gps.longitude | i32 BE | × 1.7453293e-09 × (180/π) ≈ × 1.0e-07 | degrees |
| gps.altitude | u32 BE | × 0.001 | metres |
| speed | u16 BE | × 0.0043403 | m/s |
| engine.speed | u16 BE | × 0.026180 (rad/s), then × 60/(2π) | RPM |
| steering.angle | i16 BE | × 1.0908307825e-03 (rad), then × 180/π | degrees |
| gps.heading | u16 BE | × 1.0908307825e-03 (rad), then × 180/π | degrees |
| accel.* (50 Hz) | float32 BE | 1.0 | g |

### 5.1 GPS Coordinate Encoding

GPS coordinates are stored as 32-bit signed integers representing a value in
a radians-derived unit:

```
degrees = raw_i32 × 1.7453293e-09 × (180 / π)
```

The constant `1.7453293e-09` converts from the raw integer domain to radians,
and `180/π` converts radians to degrees. The combined scale is approximately
`1.0e-07` degrees per raw unit, giving ~1 cm resolution.

### 5.2 Speed Encoding

```
speed_mps = raw_u16 × 0.0043403
speed_kph = speed_mps × 3.6
speed_mph = speed_mps × 2.23694
```

### 5.3 Engine Speed Encoding

```
speed_rad_s = raw_u16 × 0.026180
speed_rpm   = speed_rad_s × 60 / (2π) ≈ raw_u16 × 0.25
```

### 5.4 Steering / Heading Angle Encoding

```
angle_rad = raw_i16 × 1.0908307825e-03
angle_deg = angle_rad × (180 / π)
```

---

## 6. 100 Hz Sub-Frame Layout (17 bytes)

```
Offset  Size  Type    Channel             Notes
0       1     u8      motor.powerlevel
1       2     u16 BE  engine.speed        × 0.026180 rad/s → RPM
3       2     u16 BE  engine.torque       raw (scale TBD)
5       2     i16 BE  steering.angle      × 1.0908e-3 rad → degrees
7       2     u16 BE  wheel.speed.fl      raw (scale ≈ engine.speed)
9       2     u16 BE  wheel.speed.fr      raw
11      2     u16 BE  wheel.speed.rl      raw
13      2     u16 BE  wheel.speed.rr      raw
15      2     i16 BE  gyro.yaw            raw
```

---

## 7. 50 Hz Sub-Frame Layout (24 bytes)

Six IEEE 754 big-endian float32 values, each representing acceleration in g:

```
Offset  Size  Type      Channel
0       4     float32   accel.lateral.max       (positive = right)
4       4     float32   accel.lateral.min       (negative = left)
8       4     float32   accel.longitudinal.max  (positive = accel)
12      4     float32   accel.longitudinal.min  (negative = braking)
16      4     float32   accel.vertical.1
20      4     float32   accel.vertical.2
```

Typical parked values show ~0.64 g lateral offset, suggesting either a sensor
reference frame rotation or a static offset that should be zeroed at rest.

---

## 8. 10 Hz Frame Layout (28 bytes)

The 10 Hz frame consists of 2 bytes of speed followed by 26 bytes of GPS and
vehicle data. The speed bytes are located immediately *before* the latitude
position in the byte stream.

```
Offset  Size  Type    Channel
-2      2     u16 BE  speed               × 0.0043403 m/s
0       4     i32 BE  gps.latitude        × DEG_SCALE → degrees
4       4     i32 BE  gps.longitude       × DEG_SCALE → degrees
8       4     u32 BE  gps.altitude        × 0.001 → metres
12      2     u16 BE  gps.heading         × 1.0908e-3 rad → degrees
14      2     u16 BE  internal
16      1     u8      gps.fixquality      3 = PPS fix
17      1     u8      gps.satellites      typically 12–16
18      2     u16 BE  engine.coolant.temp raw
20      2     u16 BE  tire.fl.pressure    raw
22      2     u16 BE  emotor.power        raw
24      2     u16 BE  engine.power        raw
```

(Offset -2 means the speed bytes are the last 2 bytes of the *previous*
interleaving block, immediately preceding this frame's lat.)

---

## 9. 5 Hz Frame Layout (4 bytes)

Present in even-numbered 10 Hz frames (indices 0, 2, 4, 6, 8).

```
Offset  Size  Type  Channel
0       1     u8    brake
1       1     u8    engine.startstop
2       1     u8    esc.status
3       1     u8    tcs.status
```

---

## 10. 2 Hz Frame Layout (1 byte)

Present in 10 Hz frames 0 and 5.

```
Offset  Size  Type  Channel
0       1     u8    oil.pressure
```

---

## 11. 1 Hz Frame Layout (31 bytes)

Present only in 10 Hz frame 0. Contains 27 channels with tyres, VIN, odometer,
and other slowly-changing vehicle parameters. Full byte-level mapping is
incomplete.

---

## 12. Extraction Methods

### 12.1 Via ffmpeg

```bash
ffmpeg -v quiet -i input.mp4 -map 0:1 -c copy -f data telemetry_raw.bin
```

This extracts the raw data track. The resulting file contains a 14-byte init
packet followed by uniform-sized data packets (typically 3247 bytes).

### 12.2 Direct MP4 Parsing

1. Navigate to `moov` box
2. Iterate `trak` boxes; for each, recursively find `hdlr` and check for
   `handler_type == "adrv"`, or find `stsd` and check for `adco` codec tag
3. Parse the sample table (`stsz`, `stco`/`co64`, `stsc`) to get sample
   offsets and sizes
4. Read each sample directly from the file at its absolute offset

---

## 13. Outing Properties (`adop`)

The `adop` box contains metadata about the recording session, stored as
key-value pairs. Known properties include:

- Vehicle model identifier (e.g., "A2LL" for Cadillac CT5)
- VIN
- Track/venue name
- GPS bounding box (min/max lat/lon as float64)
- Recording start timestamp
- Firmware version

GPS bounding-box coordinates are stored as big-endian IEEE 754 float64 (double)
values in degrees and can be used as a reference location for GPS search within
data packets.

---

## 14. Comparison with Older Marlin Format

| Feature | AliveDrive PDR 2.5 | Marlin (C7/C8 Corvette) |
|---------|-------------------|------------------------|
| Handler type | `adrv` | `ctbx` |
| Codec tag | `adco` | `mrld` / `mrlv` / `marl` |
| Data layout | Time-interleaved | Planar (one channel per block) |
| GPS encoding | Radians-derived i32 | Direct float or fixed-point |
| Accelerometer | IEEE 754 float32 | Fixed-point integer |
| Rate groups | 6 (100/50/10/5/2/1 Hz) | Varies |
| Sub-boxes | advi/adop/adcp/adcr/adud/adeg | Different structure |

---

## 15. Known Limitations and Open Questions

1. **Rate-table width interpretation**: The exact relationship between the
   rate-table `width` field and actual stored bytes is unclear. The pattern
   appears to be that each channel includes a quality/validity byte in the
   width that is not stored in the data stream, but the ratio is not perfectly
   consistent across all groups.

2. **1 Hz data**: The 31-byte 1 Hz frame structure is not fully mapped. It
   contains 27 channels but the exact byte assignment for each is unconfirmed.

3. **Wheel speed scale**: Wheel speeds are stored as u16 values. The scale
   factor is close to, but not confirmed identical to, the engine speed scale
   (0.026180 rad/s).

4. **Torque scale**: Engine torque is stored as u16 but the scale factor and
   unit (N·m? lb·ft?) have not been determined.

5. **Accelerometer offset**: The 50 Hz accelerometer data shows a ~0.64 g
   lateral offset when the vehicle is stationary. This may be a sensor
   reference frame issue or a static offset requiring calibration subtraction.

6. **Preamble structure**: The first ~14 bytes of each data packet appear to
   contain partial 100 Hz / 50 Hz sub-frames from the previous timing period.
   The exact structure depends on where the previous second's data ended.

7. **Variable packet sizes**: While most packets are 3247 bytes, some are
   slightly larger (2098, 3258, 3269, 3346 bytes observed). The additional
   bytes likely represent extra sub-frames at recording boundaries or rate
   adjustment periods.

---

## 16. Reference Implementation

See `alivedrive_parser.py` in this directory for a working Python parser that
extracts all decoded channels to CSV. It supports both direct MP4 parsing and
pre-extracted raw binary files.

```bash
# Direct from MP4
python alivedrive_parser.py ADV_0600.mp4 --csv output.csv

# From pre-extracted binary
python alivedrive_parser.py telemetry_raw.bin --raw --csv output.csv
```
