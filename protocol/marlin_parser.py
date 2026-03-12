#!/usr/bin/env python3
"""
Marlin PDR Telemetry Parser
Decodes telemetry data from Marlin/Cosworth PDR MP4 files (Corvette C7/C8, Camaro, etc.)

Uses random-access file I/O to handle multi-GB files without loading into memory.
Reads the self-describing channel dictionary (mrld) and decodes event-driven
telemetry records from the marl data track.

Reference: protocol/MARLIN_FORMAT.md
"""

import struct
import sys
import csv
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from dataclasses import dataclass, field
from datetime import datetime, timezone


# =============================================================================
# Constants
# =============================================================================

TICKS_PER_SECOND = 10_000_000  # 100 ns ticks

# Unit conversion: SI base units → display units
# The mrld multiplier/offset converts raw → SI; these convert SI → display
UNIT_SCALE = {
    '°C':     1.0,       # Kelvin → °C (offset handles conversion)
    'G':      1/9.80665, # m/s² → G
    'kph':    3.6,       # m/s → km/h
    '°':      180/math.pi,  # rad → degrees
    '°/s':    180/math.pi,  # rad/s → deg/s
    '°/sec':  180/math.pi,
    '%':      100,       # fraction → percent
    'kPa':    1/1000,    # Pa → kPa
    'rpm':    10,        # Cosworth RPM encoding quirk
    'km':     1/1000,    # m → km
    'ltr':    1000,      # m³ → litres
    'mm':     1000,      # m → mm
}

UNIT_OFFSET = {
    '°C': -273.15,  # Kelvin → Celsius
}

# Gear value labels
GEAR_LABELS = {
    0: 'unknown', 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6',
    7: '7', 8: '8', 9: '9', 10: '10', 11: '11', 12: '12',
    13: 'N', 14: 'R', 15: 'P',
}


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class MarlinChannel:
    """A single channel definition from the mrld dictionary."""
    channel_id: int
    type_id: int
    num: int
    units: str
    flags: int
    interval_ticks: int  # in 100 ns units
    min_raw: int
    max_raw: int
    display_min: float
    display_max: float
    multiplier: float
    offset: float
    name: str
    description: str

    @property
    def rate_hz(self) -> float:
        if self.interval_ticks == 0:
            return 0.0
        return TICKS_PER_SECOND / self.interval_ticks

    @property
    def actual_mult(self) -> float:
        """Combined multiplier: raw → display units."""
        return self.multiplier * UNIT_SCALE.get(self.units, 1.0)

    @property
    def actual_offset(self) -> float:
        """Combined offset: raw → display units."""
        return (self.offset * UNIT_SCALE.get(self.units, 1.0)
                + UNIT_OFFSET.get(self.units, 0.0))

    def convert(self, raw: int) -> float:
        """Convert raw integer to display value."""
        return raw * self.actual_mult + self.actual_offset


@dataclass
class MarlinMetadata:
    """Recording metadata from the mrlv box."""
    recording_id: str = ''
    start_time: str = ''
    start_date: str = ''
    end_time: str = ''
    end_date: str = ''
    timezone: str = ''
    language: str = ''
    track_name: str = ''
    recording_type: str = ''
    country: str = ''
    software_version: str = ''
    unit_system: str = ''
    start_timestamp_ticks: int = 0  # 100 ns since Unix epoch

    @property
    def start_datetime(self) -> Optional[datetime]:
        if self.start_timestamp_ticks > 0:
            unix_seconds = self.start_timestamp_ticks / TICKS_PER_SECOND
            return datetime.fromtimestamp(unix_seconds, tz=timezone.utc)
        return None

    @property
    def duration_label(self) -> str:
        if self.start_time and self.end_time:
            return f"{self.start_date} {self.start_time} – {self.end_time}"
        return ''


@dataclass
class MarlinMeasurement:
    """A single decoded measurement."""
    timestamp_ticks: int
    channel_id: int
    raw_value: int


@dataclass
class ParseResult:
    """Complete parse result."""
    metadata: MarlinMetadata
    channels: Dict[int, MarlinChannel]
    measurements: List[MarlinMeasurement]
    version: int = 0
    sample_count: int = 0


# =============================================================================
# MP4 Box Navigation (random-access file I/O)
# =============================================================================

def read_box_header(f) -> Optional[Tuple[bytes, int, int, int]]:
    """Read an MP4 box header at the current file position.
    Returns (type, total_size, header_size, box_start) or None."""
    box_start = f.tell()
    hdr = f.read(8)
    if len(hdr) < 8:
        return None

    size = struct.unpack('>I', hdr[0:4])[0]
    box_type = hdr[4:8]
    header_size = 8

    if size == 1:
        ext = f.read(8)
        if len(ext) < 8:
            return None
        size = struct.unpack('>Q', ext)[0]
        header_size = 16
    elif size == 0:
        # Box extends to EOF
        f.seek(0, 2)
        file_end = f.tell()
        size = file_end - box_start
        f.seek(box_start + 8)

    return (box_type, size, header_size, box_start)


CONTAINER_BOXES = {b'moov', b'trak', b'mdia', b'minf', b'stbl', b'udta', b'dinf'}


def find_box(f, target_type: bytes, start: int, end: int) -> Optional[Tuple[int, int]]:
    """Find a box by type within a range. Returns (data_start, data_size) or None."""
    f.seek(start)
    while f.tell() < end:
        result = read_box_header(f)
        if not result:
            break
        box_type, box_size, header_size, box_start = result

        if box_size < 8 or box_start + box_size > end:
            break

        data_start = box_start + header_size
        data_size = box_size - header_size

        if box_type == target_type:
            return (data_start, data_size)

        if box_type in CONTAINER_BOXES:
            inner = find_box(f, target_type, data_start, box_start + box_size)
            if inner:
                return inner

        f.seek(box_start + box_size)

    return None


def iter_boxes(f, start: int, end: int):
    """Iterate over boxes in a range, yielding (type, data_start, data_size)."""
    f.seek(start)
    while f.tell() < end:
        result = read_box_header(f)
        if not result:
            break
        box_type, box_size, header_size, box_start = result
        if box_size < 8 or box_start + box_size > end:
            break
        yield (box_type, box_start + header_size, box_size - header_size, box_start + box_size)
        f.seek(box_start + box_size)


# =============================================================================
# Track Discovery
# =============================================================================

def find_marlin_track(f, file_size: int) -> Optional[Tuple[int, int]]:
    """Find the Marlin data track (handler_type='ctbx').
    Returns (trak_data_start, trak_data_end) or None."""

    # Find moov
    moov = find_box(f, b'moov', 0, file_size)
    if not moov:
        return None
    moov_start, moov_size = moov

    # Iterate trak boxes
    for box_type, data_start, data_size, next_pos in iter_boxes(f, moov_start, moov_start + moov_size):
        if box_type != b'trak':
            continue

        trak_start = data_start
        trak_end = data_start + data_size

        # Find hdlr within this trak
        hdlr = find_box(f, b'hdlr', trak_start, trak_end)
        if not hdlr:
            continue

        hdlr_start, hdlr_size = hdlr
        f.seek(hdlr_start)
        hdlr_data = f.read(min(hdlr_size, 24))
        if len(hdlr_data) >= 12:
            handler_type = hdlr_data[8:12]
            if handler_type == b'ctbx':
                return (trak_start, trak_end)

    return None


# =============================================================================
# Sample Table Parsing
# =============================================================================

def parse_sample_table(f, trak_start: int, trak_end: int) -> Optional[Dict]:
    """Parse the sample table (stbl) from a track.
    Returns dict with chunk_offsets and sample_sizes."""

    stbl = find_box(f, b'stbl', trak_start, trak_end)
    if not stbl:
        return None
    stbl_start, stbl_size = stbl
    stbl_end = stbl_start + stbl_size

    result = {
        'chunk_offsets': [],
        'sample_sizes': [],
        'timescale': 1000,
        'duration': 0,
    }

    # Parse mdhd for timescale
    mdhd = find_box(f, b'mdhd', trak_start, trak_end)
    if mdhd:
        f.seek(mdhd[0])
        mdhd_data = f.read(min(mdhd[1], 32))
        if len(mdhd_data) >= 24:
            version = mdhd_data[0]
            if version == 0:
                result['timescale'] = struct.unpack('>I', mdhd_data[12:16])[0]
                result['duration'] = struct.unpack('>I', mdhd_data[16:20])[0]
            else:
                result['timescale'] = struct.unpack('>I', mdhd_data[20:24])[0]
                result['duration'] = struct.unpack('>Q', mdhd_data[24:32])[0]

    # Parse stsz (sample sizes)
    stsz = find_box(f, b'stsz', stbl_start, stbl_end)
    if stsz:
        f.seek(stsz[0])
        stsz_hdr = f.read(12)
        if len(stsz_hdr) >= 12:
            default_size = struct.unpack('>I', stsz_hdr[4:8])[0]
            sample_count = struct.unpack('>I', stsz_hdr[8:12])[0]
            if default_size != 0:
                result['sample_sizes'] = [default_size] * sample_count
            else:
                data = f.read(sample_count * 4)
                result['sample_sizes'] = [
                    struct.unpack('>I', data[i*4:i*4+4])[0]
                    for i in range(min(sample_count, len(data) // 4))
                ]

    # Parse stco or co64 (chunk offsets)
    stco = find_box(f, b'stco', stbl_start, stbl_end)
    if stco:
        f.seek(stco[0])
        stco_hdr = f.read(8)
        if len(stco_hdr) >= 8:
            entry_count = struct.unpack('>I', stco_hdr[4:8])[0]
            data = f.read(entry_count * 4)
            result['chunk_offsets'] = [
                struct.unpack('>I', data[i*4:i*4+4])[0]
                for i in range(min(entry_count, len(data) // 4))
            ]
    else:
        co64 = find_box(f, b'co64', stbl_start, stbl_end)
        if co64:
            f.seek(co64[0])
            co64_hdr = f.read(8)
            if len(co64_hdr) >= 8:
                entry_count = struct.unpack('>I', co64_hdr[4:8])[0]
                data = f.read(entry_count * 8)
                result['chunk_offsets'] = [
                    struct.unpack('>Q', data[i*8:i*8+8])[0]
                    for i in range(min(entry_count, len(data) // 8))
                ]

    if not result['chunk_offsets'] or not result['sample_sizes']:
        return None

    return result


# =============================================================================
# Marlin Sub-Box Parsing
# =============================================================================

def parse_stsd_marlin(f, trak_start: int, trak_end: int) -> Tuple[int, MarlinMetadata, Dict[int, MarlinChannel]]:
    """Parse the marl stsd entry to extract mrlh, mrlv, and mrld.
    Returns (version, metadata, channels)."""

    stsd = find_box(f, b'stsd', trak_start, trak_end)
    if not stsd:
        return (0, MarlinMetadata(), {})

    stsd_start, stsd_size = stsd
    f.seek(stsd_start)
    stsd_header = f.read(8)
    entry_count = struct.unpack('>I', stsd_header[4:8])[0]

    # Read the marl sample entry
    entry_hdr = f.read(4)
    entry_size = struct.unpack('>I', entry_hdr)[0]
    entry_format = f.read(4)

    if entry_format != b'marl':
        return (0, MarlinMetadata(), {})

    # Skip reserved (6) + data_ref_index (2) = 8 bytes
    f.read(8)

    # Now at the start of sub-boxes within the marl entry
    entry_data_start = f.tell()
    entry_data_end = stsd_start + 8 + entry_size  # entry starts after version/flags+count

    # Read all sub-box data into memory (typically ~40KB)
    f.seek(entry_data_start)
    entry_data = f.read(entry_data_end - entry_data_start)

    version = 0
    metadata = MarlinMetadata()
    channels: Dict[int, MarlinChannel] = {}

    # Parse sub-boxes
    pos = 0
    while pos + 8 <= len(entry_data):
        sub_size = struct.unpack('>I', entry_data[pos:pos+4])[0]
        sub_type = entry_data[pos+4:pos+8]
        if sub_size < 8 or pos + sub_size > len(entry_data):
            break

        sub_data = entry_data[pos+8:pos+sub_size]

        if sub_type == b'mrlh':
            version = _parse_mrlh(sub_data)
        elif sub_type == b'mrlv':
            metadata = _parse_mrlv(sub_data)
        elif sub_type == b'mrld':
            channels = _parse_mrld(sub_data)

        pos += sub_size

    return (version, metadata, channels)


def _parse_mrlh(data: bytes) -> int:
    """Parse mrlh header. Returns version number."""
    if len(data) >= 4:
        return struct.unpack('>I', data[0:4])[0]
    return 0


def _parse_mrlv(data: bytes) -> MarlinMetadata:
    """Parse mrlv metadata tags."""
    meta = MarlinMetadata()

    fmt_sizes = {
        b'strs': 64, b'lang': 64, b'strl': 256, b'time': 32,
        b'date': 32, b'tmzn': 32, b'tstm': 8, b'focc': 4,
    }

    pos = 0
    while pos + 8 <= len(data):
        tag = data[pos:pos+4]
        fmt = data[pos+4:pos+8]

        # kvp format (key-value pair)
        if fmt[:3] == b'kvp':
            length = 320
            pos += 8 + length
            continue

        length = fmt_sizes.get(fmt)
        if length is None:
            break

        if pos + 8 + length > len(data):
            break

        value_data = data[pos+8:pos+8+length]

        if fmt == b'tstm' and len(value_data) >= 8:
            meta.start_timestamp_ticks = struct.unpack('>Q', value_data[:8])[0]
        elif fmt == b'focc':
            text = value_data[:4].decode('ascii', errors='ignore').rstrip('\x00')
            if tag == b'rtyp':
                meta.recording_type = text
            elif tag == b'unit':
                meta.unit_system = 'U.S. Imperial' if text == 'usim' else text
        else:
            text = value_data.rstrip(b'\x00').decode('utf-8', errors='ignore')
            if tag == b'id  ':
                meta.recording_id = text
            elif tag == b'time':
                meta.start_time = text
            elif tag == b'zone':
                meta.timezone = text
            elif tag == b'date':
                meta.start_date = text
            elif tag == b'lang':
                meta.language = text
            elif tag == b'ltim':
                meta.end_time = text
            elif tag == b'ldat':
                meta.end_date = text
            elif tag == b'trkn':
                meta.track_name = text
            elif tag == b'cntr':
                meta.country = text
            elif tag == b'swvs':
                meta.software_version = text

        pos += 8 + length

    return meta


MRLD_RECORD_SIZE = 448
MRLD_STRUCT_FMT = '>III64sIQiidddd64s64s'
MRLD_STRUCT_SIZE = struct.calcsize(MRLD_STRUCT_FMT)  # 256 bytes


def _parse_mrld(data: bytes) -> Dict[int, MarlinChannel]:
    """Parse mrld channel dictionary."""
    channels = {}
    pos = 0

    while pos + MRLD_RECORD_SIZE <= len(data):
        parts = struct.unpack_from(MRLD_STRUCT_FMT, data, pos)

        channel_id = parts[0]
        type_id = parts[1]
        num = parts[2]
        units = parts[3].rstrip(b'\x00').decode('utf-8', errors='ignore')
        flags = parts[4]
        interval = parts[5]
        min_raw = parts[6]
        max_raw = parts[7]
        display_min = parts[8]
        display_max = parts[9]
        multiplier = parts[10]
        offset = parts[11]
        name = parts[12].rstrip(b'\x00').decode('utf-8', errors='ignore')
        description = parts[13].rstrip(b'\x00').decode('utf-8', errors='ignore')

        channels[channel_id] = MarlinChannel(
            channel_id=channel_id,
            type_id=type_id,
            num=num,
            units=units,
            flags=flags,
            interval_ticks=interval,
            min_raw=min_raw,
            max_raw=max_raw,
            display_min=display_min,
            display_max=display_max,
            multiplier=multiplier,
            offset=offset,
            name=name,
            description=description,
        )

        pos += MRLD_RECORD_SIZE

    return channels


# =============================================================================
# Telemetry Decoding
# =============================================================================

def decode_and_resample(f, sample_table: Dict,
                        channels: Dict[int, MarlinChannel],
                        progress_callback=None) -> Tuple[List[Dict[str, Any]], int]:
    """Decode all samples and resample to 10 Hz in a single pass.

    Each sample is independently decodable. We process samples in order,
    snapshot the channel state at each sample boundary, then interpolate
    onto a 10 Hz grid after collecting all snapshots.

    Returns (records, total_measurement_count).
    """
    chunk_offsets = sample_table['chunk_offsets']
    sample_sizes = sample_table['sample_sizes']
    total_samples = min(len(chunk_offsets), len(sample_sizes))

    # Phase 1: Decode all samples, collecting per-sample snapshots
    # Each snapshot is (last_timestamp_ticks, {channel_id: raw_value})
    snapshots: List[Tuple[int, Dict[int, int]]] = []
    total_records = 0

    for i in range(total_samples):
        offset = chunk_offsets[i]
        size = sample_sizes[i]

        f.seek(offset)
        data = f.read(size)
        if len(data) < size:
            break

        # Decode sample — collect (timestamp, channel, value) tuples inline
        sample_raw: Dict[int, int] = {}
        last_ts = 0
        pos = 0
        channel = 0

        while pos + 8 <= len(data):
            a0 = struct.unpack('>I', data[pos:pos+4])[0]
            a1 = struct.unpack('>I', data[pos+4:pos+8])[0]
            high_byte = a0 >> 24

            if high_byte == 0xFF:
                break

            if (high_byte & 0xC0) == 0xC0:
                # Full record (16 bytes)
                channel = a0 & 0x0FFFFFFF
                raw_value = a1 if a1 < 0x80000000 else a1 - 0x100000000
                if pos + 16 > len(data):
                    break
                ts_high, ts_low = struct.unpack('>II', data[pos+8:pos+16])
                timestamp = (ts_high << 32) | ts_low

                sample_raw[channel] = raw_value

                # ts_high == 0xFFFFFFFF is a sentinel meaning "not yet valid"
                # — skip these for time tracking (value is still recorded)
                if ts_high != 0xFFFFFFFF and timestamp > last_ts:
                    last_ts = timestamp
                total_records += 1
                pos += 16

            elif (high_byte & 0xC0) == 0x40:
                # Diff record (8 bytes)
                chan_diff = high_byte & 0x3F
                if chan_diff & 0x20:
                    chan_diff -= 0x40
                channel += chan_diff
                val_diff = a0 & 0x00FFFFFF
                if val_diff & 0x800000:
                    val_diff -= 0x1000000
                timestamp = last_ts + a1
                last_ts = timestamp
                if channel not in sample_raw:
                    sample_raw[channel] = 0
                sample_raw[channel] += val_diff
                total_records += 1
                pos += 8
            else:
                pos += 8

        if sample_raw and last_ts > 0:
            snapshots.append((last_ts, sample_raw))

        if progress_callback and (i % 100 == 0 or i == total_samples - 1):
            progress_callback(i + 1, total_samples)

    if not snapshots:
        return ([], total_records)

    # Phase 2: Build 10 Hz time grid with carry-forward interpolation
    # Snapshots are already in time order (samples are sequential)
    # Use timestamp 0 as start (timestamps are relative to recording start)
    first_ts = 0
    last_ts = max(ts for ts, _ in snapshots)
    total_ticks = last_ts - first_ts

    if total_ticks <= 0:
        return ([], total_records)

    interval_ticks = TICKS_PER_SECOND // 10  # 0.1s
    num_steps = int(total_ticks / interval_ticks) + 1

    # Merge all snapshots into a running state, emitting grid records
    current_raw: Dict[int, int] = {}
    records: List[Dict[str, Any]] = []
    snap_idx = 0

    for step in range(num_steps):
        grid_ts = first_ts + step * interval_ticks

        # Apply all snapshots up to this grid point
        while snap_idx < len(snapshots) and snapshots[snap_idx][0] <= grid_ts:
            current_raw.update(snapshots[snap_idx][1])
            snap_idx += 1

        # Build record with converted values
        record = {'time_s': round(grid_ts / TICKS_PER_SECOND, 4)}
        for ch_id, raw in current_raw.items():
            if ch_id in channels:
                record[channels[ch_id].name] = channels[ch_id].convert(raw)
        records.append(record)

    return (records, total_records)


# =============================================================================
# CSV Output
# =============================================================================

# Preferred column order for CSV output
CSV_COLUMNS_PRIORITY = [
    'time_s',
    # GPS
    'Latitude', 'Longitude', 'Altitude', 'Speed', 'Heading',
    'GPS Fix', 'GPS Precision', 'Number of Satellites',
    # Core vehicle
    'RPM', 'Gear', 'Accelerator', 'Brake Pos', 'Steering Angle',
    # Acceleration
    'Lateral Acceleration', 'Longitudinal Acceleration', 'Vertical Acceleration',
    'Yaw Rate',
    # Wheel speeds
    'Wheel Speed Left Front', 'Wheel Speed Right Front',
    'Wheel Speed Left Rear', 'Wheel Speed Right Rear',
    # Temperatures
    'Coolant Temp', 'Oil Temp', 'Trans Oil Temp',
    'Outside Air Temperature', 'Intake Air Temperature',
    # Pressures
    'Oil Pressure', 'Intake Boost Pressure', 'Boost Pressure Ind',
    # Tyre pressures
    'LF Tyre Pressure', 'RF Tyre Pressure', 'LR Tyre Pressure', 'RR Tyre Pressure',
    'LF Tyre Temp', 'RF Tyre Temp', 'LR Tyre Temp', 'RR Tyre Temp',
    # Power
    'Engine Power', 'Engine Torque', 'Electric Motor Power', 'Electric Motor Torque',
    # Suspension
    'Suspension Displacement Left Front', 'Suspension Displacement Right Front',
    'Suspension Displacement Left Rear', 'Suspension Displacement Right Rear',
    # Other
    'Battery Voltage', 'Fuel Level', 'Fuel Capacity', 'Distance',
    'ABS Active', 'Traction Control Active', 'Vehicle Stability Active',
    'Performance Traction Management', 'Driver Performance Mode',
]


def write_csv(records: List[Dict], channels: Dict[int, MarlinChannel],
              csv_path: str, metadata: MarlinMetadata = None):
    """Write resampled records to CSV."""
    if not records:
        return

    # Determine columns: priority order first, then any remaining
    all_channel_names = {ch.name for ch in channels.values()}
    # Use last record — carry-forward means it has all channels that ever appeared
    present_names = set()
    if records:
        present_names = {k for k in records[-1].keys() if k != 'time_s'}

    columns = ['time_s']
    for name in CSV_COLUMNS_PRIORITY:
        if name != 'time_s' and name in present_names:
            columns.append(name)
    # Add remaining channels in ID order
    remaining = present_names - set(columns)
    for ch_id in sorted(channels.keys()):
        if channels[ch_id].name in remaining:
            columns.append(channels[ch_id].name)

    with open(csv_path, 'w', newline='') as f:
        # Write metadata header as comments
        if metadata:
            if metadata.track_name:
                f.write(f"# Track: {metadata.track_name}\n")
            if metadata.start_date:
                f.write(f"# Date: {metadata.start_date} {metadata.start_time}\n")
            if metadata.software_version:
                f.write(f"# Software: {metadata.software_version}\n")
            f.write(f"# Channels: {len(channels)}\n")
            f.write(f"# Records: {len(records)}\n")

        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        for record in records:
            writer.writerow(record)


# =============================================================================
# Main API
# =============================================================================

def parse_marlin_file(mp4_path: str, csv_path: str = None,
                      verbose: bool = False) -> Optional[ParseResult]:
    """Parse a Marlin PDR MP4 file and optionally export CSV.

    Args:
        mp4_path: Path to the MP4 file
        csv_path: Optional CSV output path (defaults to same name with .csv)
        verbose: Print detailed progress info

    Returns:
        ParseResult with metadata, channels, and measurements
    """
    mp4_path = Path(mp4_path)
    if not mp4_path.exists():
        print(f"Error: File not found: {mp4_path}", file=sys.stderr)
        return None

    file_size = mp4_path.stat().st_size
    print(f"Reading {mp4_path.name} ({file_size / (1024**3):.2f} GB)...")

    with open(mp4_path, 'rb') as f:
        # 1. Find the Marlin data track
        track = find_marlin_track(f, file_size)
        if not track:
            print("Error: No Marlin data track found (handler 'ctbx')", file=sys.stderr)
            return None

        trak_start, trak_end = track
        print("Found Marlin data track (ctbx)")

        # 2. Parse stsd sub-boxes (mrlh, mrlv, mrld)
        version, metadata, channels = parse_stsd_marlin(f, trak_start, trak_end)

        if not channels:
            print("Error: No channel definitions found in mrld", file=sys.stderr)
            return None

        print(f"Version: 0x{version:08X}")
        print(f"Channels: {len(channels)}")
        if metadata.track_name:
            print(f"Track: {metadata.track_name}")
        if metadata.start_date:
            print(f"Date: {metadata.start_date} {metadata.start_time}")
        if metadata.software_version:
            print(f"Software: {metadata.software_version}")

        if verbose:
            # Print channel summary
            rates = {}
            for ch in channels.values():
                rate = ch.rate_hz
                rates.setdefault(rate, []).append(ch.name)
            for rate in sorted(rates.keys(), reverse=True):
                names = rates[rate]
                print(f"  {rate:6.0f} Hz: {', '.join(names[:5])}"
                      + (f" (+{len(names)-5} more)" if len(names) > 5 else ""))

        # 3. Parse sample table
        sample_table = parse_sample_table(f, trak_start, trak_end)
        if not sample_table:
            print("Error: Could not parse sample table", file=sys.stderr)
            return None

        sample_count = len(sample_table['sample_sizes'])
        duration_s = sample_table['duration'] / sample_table['timescale']
        print(f"Samples: {sample_count} ({duration_s:.1f}s duration)")

        # 4. Decode all telemetry and resample to 10 Hz
        print("Decoding telemetry and resampling to 10 Hz...")

        def progress(current, total):
            if sys.stderr.isatty():
                pct = current * 100 // total
                print(f"\r  {current}/{total} samples ({pct}%)", end='', file=sys.stderr)

        records, total_records = decode_and_resample(
            f, sample_table, channels, progress_callback=progress)

        if sys.stderr.isatty():
            print(file=sys.stderr)  # newline after progress

        print(f"Decoded {total_records:,} measurements -> {len(records)} records at 10 Hz")

    # Summary
    if records:
        speeds = [r.get('Speed', 0) for r in records]
        rpms = [r.get('RPM', 0) for r in records]
        max_speed = max(speeds) if speeds else 0
        max_rpm = max(rpms) if rpms else 0
        if max_speed > 0:
            print(f"Max speed: {max_speed:.1f} kph ({max_speed/1.609:.1f} mph)")
        if max_rpm > 0:
            print(f"Max RPM: {max_rpm:.0f}")

        lats = [r.get('Latitude', 0) for r in records if r.get('Latitude', 0) != 0]
        if lats:
            print(f"GPS: {min(lats):.4f} to {max(lats):.4f} lat "
                  f"({len(lats)}/{len(records)} points)")

    # Write CSV
    if csv_path is None:
        csv_path = str(mp4_path.with_suffix('.csv'))

    write_csv(records, channels, csv_path, metadata)
    print(f"CSV written to: {csv_path}")

    return ParseResult(
        metadata=metadata,
        channels=channels,
        measurements=[],  # not stored for memory efficiency
        version=version,
        sample_count=sample_count,
    )


# =============================================================================
# Command Line Interface
# =============================================================================

def main():
    import argparse
    parser = argparse.ArgumentParser(
        description='Marlin PDR Telemetry Parser',
        epilog='Extracts telemetry from Marlin/Cosworth PDR MP4 files'
    )
    parser.add_argument('input', help='Input MP4 file')
    parser.add_argument('--csv', '-o', help='Output CSV file path')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')
    parser.add_argument('--channels', action='store_true',
                       help='Print channel definitions and exit')

    args = parser.parse_args()

    if args.channels:
        # Just print channel info
        mp4_path = Path(args.input)
        file_size = mp4_path.stat().st_size
        with open(mp4_path, 'rb') as f:
            track = find_marlin_track(f, file_size)
            if not track:
                print("No Marlin track found", file=sys.stderr)
                sys.exit(1)
            version, metadata, channels = parse_stsd_marlin(f, track[0], track[1])

        print(f"{'Ch':>3}  {'Name':30s}  {'Units':8s}  {'Rate':>7s}  "
              f"{'Multiplier':>14s}  {'Offset':>14s}  {'Range'}")
        print("-" * 110)
        for ch_id in sorted(channels.keys()):
            ch = channels[ch_id]
            print(f"{ch_id:3d}  {ch.name:30s}  {ch.units:8s}  "
                  f"{ch.rate_hz:6.1f}Hz  "
                  f"{ch.multiplier:14.6e}  {ch.offset:14.6e}  "
                  f"[{ch.min_raw}, {ch.max_raw}]")
        sys.exit(0)

    result = parse_marlin_file(args.input, csv_path=args.csv, verbose=args.verbose)
    if not result:
        sys.exit(1)


if __name__ == '__main__':
    main()
