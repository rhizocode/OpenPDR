# Marlin PDR Telemetry Format

Documents the `marl` data track in MP4 files produced by the
Marlin / Cosworth Performance Data Recorder found in GM vehicles
including Corvette C7, Corvette C8, and Camaro with the original PDR system
(typically branded "Cougar PDR 2.0" or "Marlin").

This document covers the **Marlin** format (handler `ctbx`, codec `marl`,
sub-boxes `mrlh`/`mrlv`/`mrld`), which predates the newer **AliveDrive PDR 2.5**
format (handler `adrv`, codec `adco`).

### Abbreviations

| Abbreviation | Meaning |
|--------------|---------|
| PDR | Performance Data Recorder — Cosworth-developed system integrating a forward-facing camera, microphone, GPS, and vehicle telemetry into a single recording unit |
| MMP | Multimedia Processor — the dedicated Cosworth PDR ECU/hardware module that captures video, audio, and telemetry data |
| GPS | Global Positioning System |
| CAN | Controller Area Network — the in-vehicle serial bus used for inter-module communication |
| ABS | Anti-Lock Braking System |
| TCS | Traction Control System |
| PTM | Performance Traction Management — multi-level traction control |

---

## 1. MP4 Container Layout

The MP4 file contains three streams:

| Stream | Type | Details |
|--------|------|---------|
| 0 | H.264 video | 1920x1080 @ ~30 fps (`avc1`) |
| 1 | AAC audio | stereo (`mp4a`) |
| 2 | Marlin data | handler `ctbx`, codec `marl` |

### 1.1 Top-Level Box Order

```
ftyp        — file type
free        — padding
moov        — container for all track metadata
free        — padding (variable)
mdat        — interleaved video/audio/data samples
```

Unlike AliveDrive files (which place `moov` at the end), Marlin files place
`moov` at the **beginning** of the file, before `mdat`. This means the full
metadata is available immediately without seeking to the end.

### 1.2 Identifying the Data Track

Inside `moov/trak/mdia/hdlr`, look for `handler_type == "ctbx"`.
Alternatively, inside `moov/trak/mdia/minf/stbl/stsd`, the sample entry
will have codec tag `marl`.

The `hdlr` name string is typically `"Cougar PDR 2.0"`.

### 1.3 Sample Table

One sample per chunk (`stsc` entry: first_chunk=1, samples_per_chunk=1).
Each sample is an independently-decodable block of telemetry records.

The `mdhd` timescale is 1000 (milliseconds). Sample durations in `stts`
are variable (each sample covers a different time span).

Sample sizes (`stsz`) are variable — initialization samples at the start
of a recording are small, while full-rate samples with all channels active
are significantly larger.

---

## 2. Sample Description Entry (`marl`)

The `marl` sample entry inside `stsd` has the standard MP4 sample entry
header (16 bytes: size + format + reserved + data_ref_index), followed by
three proprietary sub-boxes:

```
stsd
└── marl (sample entry)
    ├── mrlh  — Marlin header (version)
    ├── mrlv  — Marlin values (recording metadata)
    └── mrld  — Marlin dictionary (channel definitions)
```

### 2.1 `mrlh` — Marlin Header (12 bytes)

| Offset | Size | Type   | Field   | Example |
|--------|------|--------|---------|---------|
| 0      | 4    | u32 BE | size    | 12      |
| 4      | 4    | FourCC | type    | `mrlh`  |
| 8      | 4    | u32 BE | version | 0x00040000 |

The version field encodes the major version in the upper 16 bits
(e.g. 0x00040000 = version 4).

---

## 3. Recording Metadata (`mrlv`)

The `mrlv` box contains a sequence of tag/format/value triplets describing
the recording session.

### 3.1 Triplet Structure

Each entry consists of:

| Offset | Size | Type   | Field  |
|--------|------|--------|--------|
| 0      | 4    | FourCC | tag    |
| 4      | 4    | FourCC | format |
| 8      | N    | bytes  | value  |

The value size N is determined by the format code:

| Format | Size (bytes) | Description |
|--------|-------------|-------------|
| `strs` | 64  | Null-padded short string |
| `lang` | 64  | Null-padded language string |
| `strl` | 256 | Null-padded long string |
| `time` | 32  | Null-padded time string (HH:MM:SS) |
| `date` | 32  | Null-padded date string (YYYY-MM-DD) |
| `tmzn` | 32  | Null-padded timezone string |
| `tstm` | 8   | u64 BE — timestamp in 100 ns units since Unix epoch |
| `focc` | 4   | FourCC code |
| `kvp\x00` | 320 | Key-value pair: 64-byte key + 256-byte value |

### 3.2 Known Tags

| Tag    | Format | Description |
|--------|--------|-------------|
| `id  ` | `strs` | Recording identifier |
| `time` | `time` | Recording start time (HH:MM:SS) |
| `zone` | `strs` | Timezone name |
| `date` | `date` | Recording start date (YYYY-MM-DD) |
| `lang` | `strs` | Language code (e.g. `en-US`) |
| `ltim` | `time` | Recording end time |
| `tstm` | `tstm` | Start timestamp — 100 ns units since Unix epoch (1970-01-01 00:00:00 UTC) |
| `trkn` | `strs` | Track/circuit name |
| `rtyp` | `focc` | Recording type FourCC (e.g. `user`) |
| `cntr` | `strs` | Country |
| `swvs` | `strs` | Software version string |
| `ldat` | `date` | Recording end date |
| `unit` | `focc` | Unit system FourCC — `usim` = U.S. Imperial |

### 3.3 Timestamp Conversion

The `tstm` value is a 64-bit unsigned integer counting 100 ns intervals
since 1970-01-01 00:00:00 UTC:

```
unix_seconds = tstm_value / 10,000,000
```

---

## 4. Channel Dictionary (`mrld`)

The `mrld` box contains a flat array of 448-byte channel definition records.
The number of channels is `(box_size - 8) / 448`.

### 4.1 Channel Record Layout (448 bytes)

| Offset | Size | Type   | Field       | Description |
|--------|------|--------|-------------|-------------|
| 0      | 4    | u32 BE | channel_id  | Unique channel number (1-based) |
| 4      | 4    | u32 BE | type_id     | Data type identifier (see §4.3) |
| 8      | 4    | u32 BE | num         | Channel ordinal |
| 12     | 64   | string | units       | Physical unit string, null-padded |
| 76     | 4    | u32 BE | flags       | Channel flags (see §4.4) |
| 80     | 8    | u64 BE | interval    | Sample interval in 100 ns units |
| 88     | 4    | i32 BE | min_raw     | Minimum raw value |
| 92     | 4    | i32 BE | max_raw     | Maximum raw value |
| 96     | 8    | f64 BE | display_min | Minimum display value |
| 104    | 8    | f64 BE | display_max | Maximum display value |
| 112    | 8    | f64 BE | multiplier  | Raw → SI conversion multiplier |
| 120    | 8    | f64 BE | offset      | Raw → SI conversion offset |
| 128    | 64   | string | name        | Human-readable channel name, null-padded |
| 192    | 64   | string | description | Channel description, null-padded |
| 256    | 192  | bytes  | reserved    | Zero-padded, reserved for future use |

### 4.2 Value Conversion

The multiplier and offset convert from raw integer values to SI base units.
The units string specifies the target display unit. Two-stage conversion:

**Stage 1 — Raw to SI:**
```
si_value = raw * multiplier + offset
```

**Stage 2 — SI to display units:**

| Unit String | SI Base Unit | Scale Factor | Offset |
|-------------|-------------|--------------|--------|
| `°C`        | Kelvin      | 1.0          | −273.15 |
| `G`         | m/s²        | 1/9.80665    | 0      |
| `kph`       | m/s         | 3.6          | 0      |
| `°` (angle) | radians     | 180/π        | 0      |
| `°/s` or `°/sec` | rad/s | 180/π        | 0      |
| `%`         | fraction    | 100          | 0      |
| `kPa`       | Pa          | 1/1000       | 0      |
| `rpm`       | (see note)  | 10           | 0      |
| `km`        | m           | 1/1000       | 0      |
| `ltr`       | m³          | 1000         | 0      |
| `mm`        | m           | 1000         | 0      |
| `V`, `Nm`, `kW`, `kB/s`, `Op/s`, `ms`, `m` | — | 1.0 | 0 |

**Note on RPM:** The mrld multiplier for RPM encodes π/120 (≈0.02618),
which converts raw counts to a frequency measure that requires a final ×10
factor to produce actual RPM. This is a quirk of the Cosworth encoding.

**Combined formula:**
```
display_value = raw * multiplier * unit_scale + offset * unit_scale + unit_offset
```

### 4.3 Type Identifiers

Known type IDs used in channel records:

| Type ID | Meaning | Channels |
|---------|---------|----------|
| 0       | Unsigned integer / enum | Gear, GPS Fix, ABS Active |
| 1       | Signed integer (linear) | Altitude, Distance, Suspension |
| 2       | Unsigned fraction | Fuel Capacity |
| 3       | Unsigned speed (kph-scaled) | Speed, Wheel Speeds |
| 4       | Temperature (Kelvin offset) | Coolant, Oil Temp, Tyre Temps |
| 7       | Angle (radian-scaled) | Latitude, Longitude, Steering, Heading |
| 8       | Rate (radian/s-scaled) | RPM, Yaw Rate |
| 9       | Pressure (Pa-scaled) | Intake Boost, Oil Pressure, Tyre Pressure |
| 10      | Acceleration (m/s²-scaled) | Lateral/Longitudinal/Vertical Accel |
| 11      | Voltage | Battery Voltage |
| 15      | Torque | Engine Torque, Electric Motor Torque |
| 16      | Percentage | Accelerator, Brake, Boost, Fuel Level |
| 18      | Power | Engine Power, Electric Motor Power |

### 4.4 Channel Flags

The `flags` field is a bitmask. The typical value is `7` (0b111).
Bit semantics are not fully determined; likely includes flags for
enabled/visible/logged states.

### 4.5 Sample Rate Calculation

The `interval` field is in 100 ns units. Convert to Hz:

```
rate_hz = 10,000,000 / interval
```

| Interval Value | Rate |
|---------------|------|
| 100,000       | 100 Hz |
| 200,000       | 50 Hz |
| 500,000       | 20 Hz |
| 1,000,000     | 10 Hz |
| 2,500,000     | 4 Hz |
| 5,000,000     | 2 Hz |
| 10,000,000    | 1 Hz |

---

## 5. Channel Table

The channel dictionary is self-describing — the mrld box defines all
available channels. The following tables document the known channel set.
Channel numbering starts at 1.

### 5.1 High-Rate Channels (100 Hz)

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 6  | RPM | rpm | 8 | [0, 65535] |
| 9  | Brake Pos | % | 16 | [0, 255] |
| 26 | Steering Angle | ° | 7 | [0, 65535] |
| 59 | Wheel Speed Left Front | kph | 3 | [0, 16383] |
| 60 | Wheel Speed Right Front | kph | 3 | [0, 16383] |
| 61 | Wheel Speed Left Rear | kph | 3 | [0, 16383] |
| 62 | Wheel Speed Right Rear | kph | 3 | [0, 16383] |
| 67 | Yaw Rate | °/s | 8 | [−32768, 32767] |

### 5.2 50 Hz Channels

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 7  | Accelerator | % | 16 | [0, 255] |
| 35 | Lateral Acceleration | G | 10 | [−32768, 32767] |
| 36 | Longitudinal Acceleration | G | 10 | [−32768, 32767] |
| 37 | Vertical Acceleration | G | 10 | [−32768, 32767] |

### 5.3 20 Hz Channels

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 68 | Suspension Displacement LF | mm | 1 | [−256, 255] |
| 69 | Suspension Displacement RF | mm | 1 | [−256, 255] |
| 70 | Suspension Displacement LR | mm | 1 | [−256, 255] |
| 71 | Suspension Displacement RR | mm | 1 | [−256, 255] |

### 5.4 10 Hz Channels

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 1  | Boost Pressure Ind | % | 16 | [0, 255] |
| 3  | Intake Boost Pressure | kPa | 9 | [0, 511] |
| 28 | Speed | kph | 3 | [0, 32767] |
| 38 | Latitude | ° | 7 | [−1.8×10⁹, 1.8×10⁹] |
| 39 | Longitude | ° | 7 | [−1.8×10⁹, 1.8×10⁹] |
| 40 | Altitude | m | 1 | [−3×10⁶, 3×10⁶] |
| 41 | Heading | ° | 7 | [0, 36000] |
| 42 | GPS Fix | — | 0 | [0, 99] |
| 43 | GPS Precision | — | 0 | [0, 99] |
| 44 | Number of Satellites | — | 0 | [0, 99] |
| 72 | Engine Power | kW | 18 | [0, 8191] |
| 73 | Electric Motor Power | kW | 18 | [0, 8191] |
| 74 | Engine Torque | Nm | 15 | [0, 4095] |
| 75 | Electric Motor Torque | Nm | 15 | [0, 4095] |

### 5.5 4 Hz Channels

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 22 | Gear | — | 0 | [0, 15] |
| 63 | Outside Air Temperature | °C | 4 | [0, 255] |
| 78 | Engine Start Stop State | — | 0 | [0, 3] |

### 5.6 2 Hz Channels

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 4  | Oil Pressure | kPa | 9 | [0, 255] |
| 25 | Fuel Capacity | ltr | 2 | [0, 4095] |
| 29 | ABS Active | — | 0 | [0, 1] |

### 5.7 1 Hz Channels

| Ch | Name | Units | Type | Raw Range |
|----|------|-------|------|-----------|
| 2  | Coolant Temp | °C | 4 | [0, 255] |
| 5  | Oil Temp | °C | 4 | [0, 255] |
| 8  | Clutch Pos | % | 16 | [0, 255] |
| 10–13 | Tyre Pressures (LF/RF/LR/RR) | kPa | 9 | [0, 255] |
| 14–17 | Tyre Pressure Status (LF/RF/LR/RR) | — | 0 | [0, 16] |
| 18–21 | Tyre Temps (LF/RF/LR/RR) | °C | 4 | [0, 255] |
| 23 | Trans Oil Temp | °C | 4 | [0, 255] |
| 24 | Fuel Level | % | 16 | [0, 255] |
| 27 | Distance | km | 1 | [0, 2.1×10⁹] |
| 30 | Traction Control Active | — | 0 | [0, 1] |
| 31 | Vehicle Stability Active | — | 0 | [0, 1] |
| 32 | Performance Traction Management | — | 0 | [0, 16] |
| 33 | Driver Performance Mode | — | 0 | [0, 16] |
| 34 | Battery Voltage | V | 11 | [0, 255] |
| 46 | Temperature Multimedia Processor | °C | 4 | [0, 255] |
| 47–51 | CPU metrics (User/System/Idle/IOWait/IRQ) | % | 16 | [0, 10000] |
| 52–57 | SD Card metrics | various | — | — |
| 58 | Recording Event Odometer | km | 1 | [0, 2.1×10⁹] |
| 64 | Intake Air Temperature | °C | 4 | [0, 255] |
| 65 | Temperature Internal Board | °C | 4 | [0, 255] |
| 66 | Temperature Camera Module | °C | 4 | [0, 255] |
| 76 | Customer Usable State of Charge | % | 16 | [0, 65535] |
| 77 | Electric Axle Available | — | 0 | [0, 1] |
| 79 | Engine Power Level % | % | 16 | [0, 127] |
| 80 | Battery Power Level % | % | 16 | [0, 255] |
| 81–85 | HV Battery/Motor Temps | °C | 4 | various |

### 5.8 Gear Values

| Raw | Meaning |
|-----|---------|
| 0   | Unknown / not reported |
| 1–6 | Forward gears 1–6 (manual/auto) |
| 7–12 | (Reserved / higher gears) |
| 13  | Neutral |
| 14  | Reverse |
| 15  | Park |

---

## 6. Telemetry Sample Data (`marl` records)

Each sample in the data track consists of a sequence of telemetry records
packed contiguously. Records are self-describing: the high byte of the
first word determines the record type and length.

### 6.1 Record Types

Three record types are defined:

| High Byte Bits 7:6 | Type | Size | Description |
|---------------------|------|------|-------------|
| `11` (0xC0)         | Full | 16 bytes | Absolute channel/value/timestamp |
| `01` (0x40)         | Diff | 8 bytes  | Delta from previous record |
| `0xFF`              | End  | —        | End-of-data marker |

### 6.2 Full Record (16 bytes)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|1 1|  reserved |                 channel_id                    |  Word 0
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          raw_value                            |  Word 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                        timestamp (u64)                        +  Words 2–3
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field       | Bits      | Type   | Description |
|-------------|-----------|--------|-------------|
| type_flag   | [31:30]   | —      | Always `11` (0xC0 in high byte) |
| reserved    | [29:28]   | —      | Typically 0 |
| channel_id  | [27:0]    | u28    | Channel number (matches mrld) |
| raw_value   | [31:0]    | i32 BE | Signed raw measurement value |
| timestamp   | [63:0]    | u64 BE | Absolute time in 100 ns units from recording start |

**Sentinel Timestamps:** When the upper 32 bits of the timestamp are
`0xFFFFFFFF`, the timestamp is a **sentinel** meaning "not yet valid."
This occurs in initialization records for low-rate channels (1 Hz)
at the start of a sample, before the device has established a time
reference. Decoders should **ignore sentinel timestamps** for time
tracking — the channel value is still valid and should be recorded,
but the timestamp should not be used to determine time ranges.

### 6.3 Diff Record (8 bytes)

The diff record encodes deltas relative to the previously decoded record
(carrying forward both channel and timestamp state):

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|0 1| chan_diff  |              value_diff                       |  Word 0
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                       timestamp_diff                          |  Word 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field          | Bits    | Type       | Description |
|----------------|---------|------------|-------------|
| type_flag      | [31:30] | —          | Always `01` (0x40 in high byte) |
| chan_diff       | [29:24] | i6 signed  | Channel ID delta (sign-extended from bit 29) |
| value_diff     | [23:0]  | i24 signed | Raw value delta (sign-extended from bit 23) |
| timestamp_diff | [31:0]  | u32        | Timestamp delta in 100 ns units |

**Decoder state updates:**
```
channel_id += chan_diff
timestamp  += timestamp_diff
values[channel_id] += value_diff
```

### 6.4 End Marker

A word beginning with `0xFF` signals the end of valid data in the sample.
The decoder should stop processing the current sample.

### 6.5 Timestamp Units

All timestamps (both absolute in full records and deltas in diff records)
are in **100 ns** (0.1 µs) units. To convert to seconds:

```
time_seconds = timestamp / 10,000,000
```

Timestamps are relative to the start of the recording. The absolute
wall-clock start time is given by the `tstm` tag in the `mrlv` metadata.

### 6.6 Decoding Algorithm

```
channel = None
timestamp = 0
values = {}    # channel_id → current raw value

for each sample in track:
    pos = 0
    while pos + 8 <= len(sample):
        word0 = read_u32_be(sample, pos)
        word1 = read_u32_be(sample, pos + 4)
        high_byte = word0 >> 24

        if high_byte == 0xFF:
            break  # end marker

        if (high_byte & 0xC0) == 0xC0:  # full record
            channel = word0 & 0x0FFFFFFF
            value = to_signed_32(word1)
            timestamp = read_u64_be(sample, pos + 8)
            values[channel] = value
            pos += 16

        elif (high_byte & 0xC0) == 0x40:  # diff record
            chan_diff = sign_extend_6(high_byte & 0x3F)
            val_diff = sign_extend_24(word0 & 0x00FFFFFF)
            channel += chan_diff
            timestamp += word1
            values[channel] = values.get(channel, 0) + val_diff
            pos += 8

        else:
            pos += 8  # skip unknown record type

        # Emit measurement: (timestamp, channel, values[channel])
```

### 6.7 Sample Independence

Each sample is independently decodable — it starts with full records
establishing the absolute state. The decoder state (channel, timestamp,
values) does NOT carry across sample boundaries.

In practice, files may use exclusively full records with no diff encoding.
Decoders should support both record types for compatibility across
firmware versions.

---

## 7. Output Rate Alignment

The mrld channel dictionary defines per-channel sample intervals, but the
actual telemetry stream is event-driven: measurements appear in the `marl`
data whenever the source value changes or at the channel's nominal rate,
whichever comes first.

For time-aligned CSV output at a fixed rate (e.g. 100 Hz), decoders should:

1. Parse all records and collect `(timestamp, channel_id, raw_value)` tuples
2. Sort by timestamp
3. Resample to a uniform time grid using last-known-value (carry-forward) interpolation

---

## 8. Differences from AliveDrive Format

| Feature | Marlin | AliveDrive PDR 2.5 |
|---------|--------|-------------------|
| Handler type | `ctbx` | `adrv` |
| Codec / stsd format | `marl` | `adco` |
| Channel definitions | Self-describing in `mrld` (448-byte records) | Self-describing in `adcp` (Cosworth namespace strings) |
| Data encoding | Event-driven full/diff records with individual timestamps | Fixed-rate multi-rate frames packed into fixed-size packets |
| Channel count | Up to 85 (self-describing) | 59 |
| `moov` position | Beginning of file | End of file |
| System name | "Cougar PDR 2.0" | "AliveDrive PDR 2.5" |
| Unit conversion | Two-stage (raw→SI→display) with unit scale table | Scale/offset per channel in `adcp` |

---

## 9. References

- ExifTool GM.pm module by Phil Harvey: `https://exiftool.org/forum/index.php?topic=11335`
- ISO 14496-12 (MPEG-4 Part 12): ISO base media file format
- OpenPDR AliveDrive format spec: `ALIVEDRIVE_FORMAT.md`
