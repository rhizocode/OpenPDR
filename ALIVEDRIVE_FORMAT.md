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
0       1     version (1 in PDR 2.5 files)
1       1     flags
2       1     num_groups (6)
3       1     padding
```

### 3.2 Per-Group Structure

For each of `num_groups` groups:

```
Offset  Size  Field
0       3-4   padding bytes (3 for first group, 4 for subsequent groups)
3/4     4     period (big-endian u32, in 100 ns ticks)
7/8     2     num_channels (big-endian u16)
9/10    N×3   channel entries: ch_id (u16 BE) + width (u8)
```

> **Note:** In version 1 of the `adcr` format, the first group uses 3 padding
> bytes before the period field, but all subsequent groups use 4 padding bytes.
> Parsers must account for this asymmetry.

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
> the actual byte count stored in the data stream. Each channel's rate-table
> width includes metadata overhead bytes (likely quality/validity descriptors)
> that are not written to the data. The overhead varies by data type:
>
> | Data Type | Rate-Table Width | Actual Bytes | Overhead |
> |-----------|-----------------|-------------|----------|
> | u8 status channels | 2 | 1 | 1 |
> | u16 unsigned integers | 4 | 2 | 2 |
> | i16 signed integers | 3 | 2 | 1 |
> | i32/u32 GPS coordinates | 5 | 4 | 1 |
> | float32 (accel, abs) | 9 | 4 | 5 |
> | u16 heading/pressure | 2 | 2 | 0 |
>
> There is no single universal formula. The overhead appears to encode
> per-channel metadata descriptors whose length depends on the channel type.

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

The first sample is a 14-byte initialisation packet containing a format version
and timing reference for the recording session.

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

### 4.5 Preamble Structure (14 bytes)

Each data packet begins with a 14-byte preamble before the first 10 Hz frame:

```
Offset  Size  Type    Field
0       4     u32     zero padding (always 0x00000000)
4       4     u32 BE  timestamp (100 ns ticks from recording start)
8       1     u8      flags (observed: 0x01)
9       3     ---     zero padding
12      2     u16 BE  format identifier (observed: 0x0CA1)
```

The timestamp at offset 4 increments by exactly 10,000,000 per packet
(= 1.0 second at 100 ns resolution), confirming the one-second-per-packet
timing model.

After the 14-byte preamble, the remaining bytes before the first GPS latitude
position (~41 bytes) contain leftover 100 Hz sub-frame data carried over from
the previous second's timing boundary. This gives a total preamble region of
~55 bytes before the first 10 Hz frame begins.

### 4.6 Byte Budget Verification

Per 1-second packet:
```
Preamble:      14 bytes (header + partial sub-frames)
10 Hz base:   10 × 28  = 280
5 Hz data:     5 × 4   =  20
2 Hz data:     2 × 1   =   2
1 Hz data:     1 × 31  =  31
100 Hz frames: 100 × 17 = 1700
50 Hz frames:  50 × 24  = 1200
                         ------
Total:                    3247
```

### 4.7 GPS Offset Within Packets

The first GPS latitude position occurs at a consistent offset of approximately
**57 bytes** from the packet start (14-byte header + ~41 bytes of carried-over
sub-frame data + 2 bytes of speed). Subsequent GPS positions are spaced at
regular intervals determined by the interleaving pattern (~290-320 bytes apart).

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
| wheel.speed.* | u16 BE | × 0.026180 (rad/s), then × r | m/s at wheel |
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

### 5.5 Wheel Speed Encoding

Wheel speeds use the **same angular velocity scale** as engine speed:

```
wheel_rad_s = raw_u16 × 0.026180
wheel_rpm   = wheel_rad_s × 60 / (2π)
```

To convert to vehicle speed, multiply by the effective tire rolling radius.
For a CT5-V Blackwing with 245/35R19 tires (nominal radius ~0.337 m):

```
speed_mps = wheel_rad_s × tire_radius
```

The resulting speed runs ~4-5% higher than GPS speed, which is expected due to
tire compression under load reducing the effective rolling radius vs the
geometric calculation. A best-fit effective radius of ~0.321 m (vs 0.337 m
nominal) gives GPS-matching speeds.

### 5.6 Engine Torque Encoding (Preliminary)

Engine torque is stored as u16. The encoding appears to use a **zero-offset
format** where raw value ~2048 represents zero torque:

```
torque = (raw_u16 - 2048) × scale_factor
```

At idle, raw values cluster around 1780 (small negative = engine pumping
losses). Under moderate acceleration, values rise above 2048. The scale factor
is not yet precisely determined, but `0.5 N·m` per count gives plausible
results for street driving scenarios (max observed ~540 N·m under moderate
throttle). Full wide-open-throttle data is needed to confirm the scale against
the CT5-V Blackwing's rated 905 N·m (668 lb·ft) peak torque.

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

Six IEEE 754 big-endian float32 values representing two independent 3-axis
accelerometer readings in g:

```
Offset  Size  Type      Channel               Rest Value
0       4     float32   accel.raw.lateral      ~+0.628 g
4       4     float32   accel.comp.lateral     ~-0.048 g
8       4     float32   accel.raw.longitudinal ~-0.777 g
12      4     float32   accel.comp.longitudinal ~+0.039 g
16      4     float32   accel.raw.vertical     ~+0.011 g
20      4     float32   accel.comp.vertical    ~+0.996 g
```

### 7.1 Dual Accelerometer Interpretation

The six channels are **not** min/max pairs of three axes. They represent two
independent 3-axis readings:

- **Set A** (offsets 0, 8, 16): Raw/unrotated sensor output. At rest, the
  vector magnitude is 1.00 g, but the gravity vector projects onto all three
  axes because the sensor is physically **mounted at ~17° tilt** from the
  vehicle vertical. Lateral shows +0.628 g, longitudinal shows -0.777 g.

- **Set B** (offsets 4, 12, 20): Gravity-compensated / vehicle-frame-aligned
  reading. At rest, vertical ≈ 1.0 g with near-zero lateral and longitudinal,
  indicating this output has had coordinate rotation applied.

Both sets produce vector magnitudes of ~1.00 g at rest, confirming they are
valid accelerometer readings and the apparent "0.64 g lateral offset" is
actually the gravity component in the tilted sensor's reference frame.

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
and other slowly-changing vehicle parameters.

### 11.1 Confirmed Fields

```
Offset  Size  Type  Channel             Encoding
8       1     u8    fuel.level          percentage (0–100)
9       1     u8    battery.voltage     × 0.1 → volts (e.g., 129 → 12.9 V)
11      1     u8    transmission.temp   value - 40 → °C (e.g., 135 → 95°C)
```

### 11.2 Tentative / Partially Mapped Fields

```
Offset  Size  Type  Channel             Notes
0       1     u8    status              always 0 in observed data
7       1     u8    (unknown)           values 121–140, possibly pressure raw
12-15   4     ---   tire temps (mixed)  some offsets show plausible temps
21-28   8     ---   tire IDs / VIN      ASCII-like values observed
29-30   2     ---   spare tire data     slowly changing values
```

Many of the 27 channels in this frame read as zero in the sample data,
suggesting either unused/unsupported channels for this vehicle configuration or
a byte mapping that is still off by 1-2 bytes for some entries. Additional
recordings from different vehicles and conditions would help refine the mapping.

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

### Resolved

1. ~~**Rate-table width interpretation**~~: **RESOLVED.** The rate-table width
   includes per-channel metadata overhead that varies by data type (1 byte for
   status/GPS channels, 2 for unsigned integers, 5 for float32). See §3.3.
   Additionally, the `adcr` version 1 format uses 3-byte padding for the first
   group and 4-byte padding for subsequent groups. See §3.2.

2. ~~**Wheel speed scale**~~: **RESOLVED.** Wheel speeds use the same angular
   velocity scale as engine speed (0.026180 rad/s per raw unit). The ~5%
   discrepancy vs GPS ground speed is explained by tire compression under load.
   See §5.5.

3. ~~**Accelerometer offset**~~: **RESOLVED.** The 50 Hz channels are two
   independent 3-axis accelerometer readings — one raw (physically tilted
   ~17°), one gravity-compensated. Both produce 1.00 g magnitude at rest. The
   0.64 g "offset" is gravity projected onto the tilted sensor's lateral axis.
   See §7.1.

4. ~~**Preamble structure**~~: **RESOLVED.** Each packet has a 14-byte header
   (4 zero bytes + 4-byte timestamp in 100 ns ticks + 1 flag byte + 3 zero
   bytes + 2-byte format ID), followed by ~41 bytes of carried-over 100 Hz
   sub-frame data. See §4.5.

5. ~~**Variable packet sizes**~~: **RESOLVED.** The 3346-byte packets
   (3247 + 99) contain exactly 3 extra 100 Hz sub-frames (51 bytes) + 2 extra
   50 Hz sub-frames (48 bytes) at timing boundaries. The 2098-byte packet is a
   partial final second (~0.65 s). The +11 and +22 byte variants contain
   smaller sub-frame spillover.

### Partially Resolved

6. **Torque scale**: Engine torque appears to use a zero-offset encoding
   (raw ~2048 = zero torque) with an estimated scale of ~0.5 N·m per count.
   A full wide-open-throttle recording is needed to confirm the scale against
   the vehicle's rated peak torque. See §5.6.

7. **1 Hz data**: Three fields are confirmed (fuel.level at offset 8,
   battery.voltage at offset 9, transmission.temp at offset 11). The remaining
   24 channels in the 31-byte frame are tentatively mapped but need additional
   vehicle data for confirmation. See §11.

### Remaining

8. **Full 1 Hz byte-level mapping**: Many of the 27 channels in the 1 Hz frame
   read as zero in the sample data. Additional recordings from different
   vehicles, ambient conditions, and with tire pressure monitoring active would
   help complete the mapping.

9. **adcr width metadata**: The per-channel overhead bytes in the rate-table
   width likely encode quality descriptors or min/max bounds, but their exact
   semantics are unknown.

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
