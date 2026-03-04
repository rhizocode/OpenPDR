#!/usr/bin/env python3
"""
MP4 Timing Diagnostic — Dump all timing metadata from a PDR MP4 file.

Reads mvhd, mdhd, stts, ctts, edts/elst for every track to understand
video-to-telemetry synchronization.  Also decodes the 14-byte init packet.
"""

import struct
import sys
import os

# ─── MP4 box utilities (minimal, self-contained) ────────────────────────────

CONTAINER_TYPES = {'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta'}

def read_box_header(data, offset):
    if offset + 8 > len(data):
        return None
    size = struct.unpack('>I', data[offset:offset+4])[0]
    btype = data[offset+4:offset+8].decode('ascii', errors='replace')
    hdr = 8
    if size == 1:
        if offset + 16 > len(data):
            return None
        size = struct.unpack('>Q', data[offset+8:offset+16])[0]
        hdr = 16
    elif size == 0:
        size = len(data) - offset
    return size, btype, hdr, offset + hdr


def find_box(data, box_type, offset=0, end=None):
    if end is None:
        end = len(data)
    while offset < end - 8:
        r = read_box_header(data, offset)
        if r is None or r[0] < 8:
            break
        size, btype, hdr, data_start = r
        if btype == box_type:
            return offset, size, data_start
        offset += size
    return None


def iter_boxes(data, offset, end):
    """Iterate over top-level boxes within [offset, end)."""
    while offset < end - 8:
        r = read_box_header(data, offset)
        if r is None or r[0] < 8:
            break
        size, btype, hdr, data_start = r
        yield offset, size, btype, data_start
        offset += size


# ─── Parsers for individual box types ────────────────────────────────────────

def parse_mvhd(data, offset, size):
    """Parse Movie Header Box (mvhd)."""
    d = offset  # data start
    version = data[d]
    if version == 0:
        # 4-byte fields
        creation_time = struct.unpack('>I', data[d+4:d+8])[0]
        modification_time = struct.unpack('>I', data[d+8:d+12])[0]
        timescale = struct.unpack('>I', data[d+12:d+16])[0]
        duration = struct.unpack('>I', data[d+16:d+20])[0]
    else:
        # 8-byte fields
        creation_time = struct.unpack('>Q', data[d+4:d+12])[0]
        modification_time = struct.unpack('>Q', data[d+12:d+20])[0]
        timescale = struct.unpack('>I', data[d+20:d+24])[0]
        duration = struct.unpack('>Q', data[d+24:d+32])[0]
    return {
        'version': version,
        'timescale': timescale,
        'duration': duration,
        'duration_sec': duration / timescale if timescale else 0,
    }


def parse_mdhd(data, offset, size):
    """Parse Media Header Box (mdhd)."""
    d = offset
    version = data[d]
    if version == 0:
        creation_time = struct.unpack('>I', data[d+4:d+8])[0]
        modification_time = struct.unpack('>I', data[d+8:d+12])[0]
        timescale = struct.unpack('>I', data[d+12:d+16])[0]
        duration = struct.unpack('>I', data[d+16:d+20])[0]
    else:
        creation_time = struct.unpack('>Q', data[d+4:d+12])[0]
        modification_time = struct.unpack('>Q', data[d+12:d+20])[0]
        timescale = struct.unpack('>I', data[d+20:d+24])[0]
        duration = struct.unpack('>Q', data[d+24:d+32])[0]
    return {
        'version': version,
        'timescale': timescale,
        'duration': duration,
        'duration_sec': duration / timescale if timescale else 0,
    }


def parse_hdlr(data, offset, size):
    """Parse Handler Reference Box (hdlr)."""
    d = offset
    # version(4) + predefined(4) + handler_type(4) + reserved(12) + name(var)
    handler_type = data[d+8:d+12].decode('ascii', errors='replace')
    # Name starts after 24 bytes from data start
    name_start = d + 24
    name_end = data.find(b'\x00', name_start, offset + size - 8)  # box header not included
    if name_end == -1:
        name_end = min(name_start + 64, d + size - 8)
    name = data[name_start:name_end].decode('ascii', errors='replace')
    return {'handler_type': handler_type, 'name': name}


def parse_stts(data, offset, size):
    """Parse Decoding Time to Sample Box (stts)."""
    d = offset
    version = struct.unpack('>I', data[d:d+4])[0]
    entry_count = struct.unpack('>I', data[d+4:d+8])[0]
    entries = []
    pos = d + 8
    for i in range(entry_count):
        sample_count = struct.unpack('>I', data[pos:pos+4])[0]
        sample_delta = struct.unpack('>I', data[pos+4:pos+8])[0]
        entries.append({'count': sample_count, 'delta': sample_delta})
        pos += 8
    return entries


def parse_ctts(data, offset, size):
    """Parse Composition Time to Sample Box (ctts)."""
    d = offset
    version = data[d]
    entry_count = struct.unpack('>I', data[d+4:d+8])[0]
    entries = []
    pos = d + 8
    for i in range(min(entry_count, 100)):  # limit output
        sample_count = struct.unpack('>I', data[pos:pos+4])[0]
        if version == 0:
            sample_offset = struct.unpack('>I', data[pos+4:pos+8])[0]
        else:
            sample_offset = struct.unpack('>i', data[pos+4:pos+8])[0]
        entries.append({'count': sample_count, 'offset': sample_offset})
        pos += 8
    return {'version': version, 'total_entries': entry_count, 'entries': entries}


def parse_elst(data, offset, size):
    """Parse Edit List Box (elst)."""
    d = offset
    version = data[d]
    entry_count = struct.unpack('>I', data[d+4:d+8])[0]
    entries = []
    pos = d + 8
    for i in range(entry_count):
        if version == 0:
            segment_duration = struct.unpack('>I', data[pos:pos+4])[0]
            media_time = struct.unpack('>i', data[pos+4:pos+8])[0]
            pos += 8
        else:
            segment_duration = struct.unpack('>Q', data[pos:pos+8])[0]
            media_time = struct.unpack('>q', data[pos+8:pos+16])[0]
            pos += 16
        media_rate_int = struct.unpack('>h', data[pos:pos+2])[0]
        media_rate_frac = struct.unpack('>H', data[pos+2:pos+4])[0]
        pos += 4
        entries.append({
            'segment_duration': segment_duration,
            'media_time': media_time,
            'media_rate': f"{media_rate_int}.{media_rate_frac}",
        })
    return {'version': version, 'entries': entries}


def parse_stsz(data, offset, size):
    """Parse Sample Size Box (stsz) — summary only."""
    d = offset
    default_size = struct.unpack('>I', data[d+4:d+8])[0]
    sample_count = struct.unpack('>I', data[d+8:d+12])[0]
    sizes = []
    if default_size == 0:
        for i in range(min(sample_count, 20)):
            sz = struct.unpack('>I', data[d+12+i*4:d+16+i*4])[0]
            sizes.append(sz)
    return {
        'default_size': default_size,
        'sample_count': sample_count,
        'first_sizes': sizes,
    }


def parse_stco(data, offset, size):
    """Parse Chunk Offset Box (stco) — summary only."""
    d = offset
    entry_count = struct.unpack('>I', data[d+4:d+8])[0]
    offsets = []
    for i in range(min(entry_count, 5)):
        off = struct.unpack('>I', data[d+8+i*4:d+12+i*4])[0]
        offsets.append(off)
    return {'entry_count': entry_count, 'first_offsets': offsets}


def parse_co64(data, offset, size):
    """Parse Chunk Offset Box (co64) — summary only."""
    d = offset
    entry_count = struct.unpack('>I', data[d+4:d+8])[0]
    offsets = []
    for i in range(min(entry_count, 5)):
        off = struct.unpack('>Q', data[d+8+i*8:d+16+i*8])[0]
        offsets.append(off)
    return {'entry_count': entry_count, 'first_offsets': offsets}


def parse_tkhd(data, offset, size):
    """Parse Track Header Box (tkhd)."""
    d = offset
    version = data[d]
    if version == 0:
        track_id = struct.unpack('>I', data[d+12:d+16])[0]
        duration = struct.unpack('>I', data[d+20:d+24])[0]
        width = struct.unpack('>I', data[d+76:d+80])[0] / 65536.0
        height = struct.unpack('>I', data[d+80:d+84])[0] / 65536.0
    else:
        track_id = struct.unpack('>I', data[d+20:d+24])[0]
        duration = struct.unpack('>Q', data[d+28:d+36])[0]
        width = struct.unpack('>I', data[d+88:d+92])[0] / 65536.0
        height = struct.unpack('>I', data[d+92:d+96])[0] / 65536.0
    return {
        'version': version,
        'track_id': track_id,
        'duration': duration,
        'width': width,
        'height': height,
    }


# ─── Init Packet Decoder ────────────────────────────────────────────────────

def decode_init_packet(data):
    """Decode the 14-byte init packet from the data track."""
    if len(data) < 14:
        return {'error': f'too short: {len(data)} bytes'}

    result = {
        'size': len(data),
        'hex': data[:14].hex(),
        'raw_bytes': [f'0x{b:02x}' for b in data[:14]],
    }

    # Try various interpretations
    result['as_u32'] = [
        struct.unpack('>I', data[0:4])[0],
        struct.unpack('>I', data[4:8])[0],
        struct.unpack('>I', data[8:12])[0],
    ]
    result['as_u16'] = [
        struct.unpack('>H', data[i:i+2])[0] for i in range(0, 14, 2)
    ]
    result['as_u8'] = list(data[:14])

    # Known preamble interpretation from spec
    result['interpretation'] = {
        'zero_pad_0_3': struct.unpack('>I', data[0:4])[0],
        'timestamp_100ns': struct.unpack('>I', data[4:8])[0],
        'flags_byte8': data[8],
        'zero_pad_9_11': data[9:12].hex(),
        'format_id': f"0x{struct.unpack('>H', data[12:14])[0]:04X}",
    }

    # If there are extra bytes beyond 14, show those too
    if len(data) > 14:
        result['extra_bytes'] = data[14:].hex()
        result['extra_size'] = len(data) - 14

    return result


def decode_data_packet_preamble(data):
    """Decode the 14-byte preamble of a data packet."""
    if len(data) < 14:
        return {'error': f'too short: {len(data)} bytes'}
    return {
        'zero_pad': struct.unpack('>I', data[0:4])[0],
        'timestamp_100ns_ticks': struct.unpack('>I', data[4:8])[0],
        'timestamp_seconds': struct.unpack('>I', data[4:8])[0] / 10_000_000,
        'flags': data[8],
        'pad_9_11': data[9:12].hex(),
        'format_id': f"0x{struct.unpack('>H', data[12:14])[0]:04X}",
    }


# ─── Main Diagnostic ────────────────────────────────────────────────────────

def analyze_track(mp4_data, trak_offset, trak_size, trak_data_start, track_num, mvhd_timescale):
    """Analyze a single trak box and dump all timing metadata."""
    trak_end = trak_offset + trak_size

    print(f"\n{'='*70}")
    print(f"  TRACK {track_num}")
    print(f"{'='*70}")

    # ── tkhd ──
    tkhd = find_box(mp4_data, 'tkhd', trak_data_start, trak_end)
    if tkhd:
        info = parse_tkhd(mp4_data, tkhd[2], tkhd[1])
        print(f"\n  tkhd (Track Header):")
        print(f"    track_id:  {info['track_id']}")
        print(f"    duration:  {info['duration']}  ({info['duration']/mvhd_timescale:.4f} sec @ mvhd timescale {mvhd_timescale})")
        print(f"    width x height: {info['width']} x {info['height']}")

    # ── mdia/hdlr ──
    mdia = find_box(mp4_data, 'mdia', trak_data_start, trak_end)
    handler_type = '????'
    handler_name = ''
    if mdia:
        mdia_end = mdia[0] + mdia[1]
        hdlr = find_box(mp4_data, 'hdlr', mdia[2], mdia_end)
        if hdlr:
            info = parse_hdlr(mp4_data, hdlr[2], hdlr[1])
            handler_type = info['handler_type']
            handler_name = info['name']
            print(f"\n  hdlr (Handler):")
            print(f"    type: {handler_type}")
            print(f"    name: \"{handler_name}\"")

        # ── mdhd ──
        mdhd = find_box(mp4_data, 'mdhd', mdia[2], mdia_end)
        if mdhd:
            info = parse_mdhd(mp4_data, mdhd[2], mdhd[1])
            print(f"\n  mdhd (Media Header):")
            print(f"    timescale: {info['timescale']}")
            print(f"    duration:  {info['duration']}")
            print(f"    duration_sec: {info['duration_sec']:.6f}")
            track_timescale = info['timescale']
        else:
            track_timescale = None

        # ── stbl (Sample Table) ──
        minf = find_box(mp4_data, 'minf', mdia[2], mdia_end)
        if minf:
            minf_end = minf[0] + minf[1]
            stbl = find_box(mp4_data, 'stbl', minf[2], minf_end)
            if stbl:
                stbl_end = stbl[0] + stbl[1]

                # ── stts ──
                stts = find_box(mp4_data, 'stts', stbl[2], stbl_end)
                if stts:
                    entries = parse_stts(mp4_data, stts[2], stts[1])
                    print(f"\n  stts (Decoding Time to Sample): {len(entries)} entries")
                    total_samples = 0
                    total_duration = 0
                    for i, e in enumerate(entries):
                        total_samples += e['count']
                        total_duration += e['count'] * e['delta']
                        if i < 10 or i == len(entries) - 1:
                            if track_timescale:
                                delta_sec = e['delta'] / track_timescale
                                print(f"    [{i}] count={e['count']:6d}  delta={e['delta']:8d}  ({delta_sec:.6f} sec)")
                            else:
                                print(f"    [{i}] count={e['count']:6d}  delta={e['delta']:8d}")
                        elif i == 10:
                            print(f"    ... ({len(entries) - 11} more entries)")
                    print(f"    >> Total: {total_samples} samples, cumulative duration = {total_duration}", end='')
                    if track_timescale:
                        print(f"  ({total_duration/track_timescale:.6f} sec)")
                    else:
                        print()

                    # Compute first sample decode time
                    if entries:
                        first_delta = entries[0]['delta']
                        print(f"    >> First sample delta: {first_delta}", end='')
                        if track_timescale:
                            print(f"  ({first_delta/track_timescale:.6f} sec)")
                        else:
                            print()

                # ── ctts ──
                ctts = find_box(mp4_data, 'ctts', stbl[2], stbl_end)
                if ctts:
                    info = parse_ctts(mp4_data, ctts[2], ctts[1])
                    print(f"\n  ctts (Composition Time to Sample): {info['total_entries']} entries (version {info['version']})")
                    # Show unique offset values
                    unique_offsets = set()
                    for e in info['entries']:
                        unique_offsets.add(e['offset'])
                    for i, e in enumerate(info['entries'][:15]):
                        if track_timescale:
                            off_sec = e['offset'] / track_timescale
                            print(f"    [{i}] count={e['count']:6d}  offset={e['offset']:8d}  ({off_sec:.6f} sec)")
                        else:
                            print(f"    [{i}] count={e['count']:6d}  offset={e['offset']:8d}")
                    if len(info['entries']) > 15:
                        print(f"    ... ({info['total_entries'] - 15} more entries)")
                    print(f"    >> Unique offsets: {sorted(unique_offsets)}")
                    if track_timescale:
                        print(f"    >> In seconds: {[o/track_timescale for o in sorted(unique_offsets)]}")
                else:
                    print(f"\n  ctts: NOT PRESENT")

                # ── stsz ──
                stsz = find_box(mp4_data, 'stsz', stbl[2], stbl_end)
                if stsz:
                    info = parse_stsz(mp4_data, stsz[2], stsz[1])
                    print(f"\n  stsz (Sample Sizes):")
                    print(f"    sample_count: {info['sample_count']}")
                    if info['default_size']:
                        print(f"    default_size: {info['default_size']}")
                    else:
                        print(f"    first sizes: {info['first_sizes']}")

                # ── stco / co64 ──
                stco = find_box(mp4_data, 'stco', stbl[2], stbl_end)
                co64 = find_box(mp4_data, 'co64', stbl[2], stbl_end)
                if co64:
                    info = parse_co64(mp4_data, co64[2], co64[1])
                    print(f"\n  co64 (Chunk Offsets): {info['entry_count']} chunks")
                    print(f"    first offsets: {info['first_offsets']}")
                elif stco:
                    info = parse_stco(mp4_data, stco[2], stco[1])
                    print(f"\n  stco (Chunk Offsets): {info['entry_count']} chunks")
                    print(f"    first offsets: {info['first_offsets']}")

                # ── stsd — just check codec ──
                stsd = find_box(mp4_data, 'stsd', stbl[2], stbl_end)
                if stsd:
                    d = stsd[2]
                    entry_count = struct.unpack('>I', mp4_data[d+4:d+8])[0]
                    if d + 16 <= stsd[0] + stsd[1]:
                        codec = mp4_data[d+12:d+16].decode('ascii', errors='replace')
                        print(f"\n  stsd: {entry_count} entries, first codec = \"{codec}\"")

    # ── edts/elst ──
    edts = find_box(mp4_data, 'edts', trak_data_start, trak_end)
    if edts:
        edts_end = edts[0] + edts[1]
        elst = find_box(mp4_data, 'elst', edts[2], edts_end)
        if elst:
            info = parse_elst(mp4_data, elst[2], elst[1])
            print(f"\n  edts/elst (Edit List): {len(info['entries'])} entries (version {info['version']})")
            for i, e in enumerate(info['entries']):
                mt = e['media_time']
                sd = e['segment_duration']
                print(f"    [{i}] segment_duration={sd}  media_time={mt}  media_rate={e['media_rate']}")
                if mvhd_timescale and track_timescale:
                    sd_sec = sd / mvhd_timescale
                    mt_sec = mt / track_timescale if mt >= 0 else mt
                    print(f"         segment_duration = {sd_sec:.6f} sec (mvhd timescale)")
                    if mt >= 0:
                        print(f"         media_time = {mt_sec:.6f} sec (track timescale)")
                    else:
                        print(f"         media_time = {mt} (empty edit / delay)")
    else:
        print(f"\n  edts/elst: NOT PRESENT")

    return handler_type, handler_name


def main():
    if len(sys.argv) < 2:
        print("Usage: python mp4_timing_diagnostic.py <file.mp4>")
        sys.exit(1)

    filepath = sys.argv[1]
    filesize = os.path.getsize(filepath)
    print(f"File: {filepath}")
    print(f"Size: {filesize:,} bytes ({filesize/1024/1024:.1f} MB)")

    # Read the moov box (we need to find it first without loading everything)
    moov_offset = None
    moov_size = None

    with open(filepath, 'rb') as f:
        pos = 0
        while pos < filesize:
            f.seek(pos)
            hdr_data = f.read(16)
            if len(hdr_data) < 8:
                break
            size = struct.unpack('>I', hdr_data[0:4])[0]
            btype = hdr_data[4:8].decode('ascii', errors='replace')
            if size == 1:
                if len(hdr_data) < 16:
                    break
                size = struct.unpack('>Q', hdr_data[8:16])[0]
            elif size == 0:
                size = filesize - pos

            print(f"  Top-level box: {btype} at offset {pos}, size {size:,}")

            if btype == 'moov':
                moov_offset = pos
                moov_size = size
                break
            if size < 8:
                break
            pos += size

    if moov_offset is None:
        print("ERROR: Could not find moov box")
        sys.exit(1)

    # Read just the moov box
    with open(filepath, 'rb') as f:
        f.seek(moov_offset)
        moov_data = f.read(moov_size)

    print(f"\nmoov box: offset={moov_offset}, size={moov_size:,}")

    # Parse moov header
    moov_hdr = read_box_header(moov_data, 0)
    if not moov_hdr:
        print("ERROR: Could not parse moov header")
        sys.exit(1)
    moov_data_start = moov_hdr[3]

    # ── mvhd ──
    mvhd = find_box(moov_data, 'mvhd', moov_data_start, len(moov_data))
    mvhd_timescale = 1000  # default
    if mvhd:
        info = parse_mvhd(moov_data, mvhd[2], mvhd[1])
        mvhd_timescale = info['timescale']
        print(f"\nmvhd (Movie Header):")
        print(f"  timescale: {info['timescale']}")
        print(f"  duration:  {info['duration']}  ({info['duration_sec']:.4f} sec)")

    # ── Iterate all trak boxes ──
    track_num = 0
    data_track_info = None  # (trak_offset, trak_size, trak_data_start, track_timescale)
    video_track_info = None

    for off, sz, btype, dstart in iter_boxes(moov_data, moov_data_start, len(moov_data)):
        if btype == 'trak':
            track_num += 1
            ht, hn = analyze_track(moov_data, off, sz, dstart, track_num, mvhd_timescale)

    # ── Now read the init packet and first data packets from the adrv track ──
    print(f"\n{'='*70}")
    print(f"  DATA TRACK PACKET ANALYSIS")
    print(f"{'='*70}")

    # Re-find the adrv track to get sample table
    track_num = 0
    for off, sz, btype, dstart in iter_boxes(moov_data, moov_data_start, len(moov_data)):
        if btype == 'trak':
            track_num += 1
            trak_end = off + sz
            mdia = find_box(moov_data, 'mdia', dstart, trak_end)
            if not mdia:
                continue
            mdia_end = mdia[0] + mdia[1]
            hdlr = find_box(moov_data, 'hdlr', mdia[2], mdia_end)
            if not hdlr:
                continue
            info = parse_hdlr(moov_data, hdlr[2], hdlr[1])
            if info['handler_type'] != 'adrv':
                continue

            # Found the data track — get its sample table
            minf = find_box(moov_data, 'minf', mdia[2], mdia_end)
            if not minf:
                continue
            stbl = find_box(moov_data, 'stbl', minf[2], minf[0]+minf[1])
            if not stbl:
                continue
            stbl_end = stbl[0] + stbl[1]

            # stsz
            stsz = find_box(moov_data, 'stsz', stbl[2], stbl_end)
            if not stsz:
                continue
            d = stsz[2]
            default_size = struct.unpack('>I', moov_data[d+4:d+8])[0]
            sample_count = struct.unpack('>I', moov_data[d+8:d+12])[0]
            sizes = []
            if default_size:
                sizes = [default_size] * min(sample_count, 10)
            else:
                for i in range(min(sample_count, 10)):
                    sizes.append(struct.unpack('>I', moov_data[d+12+i*4:d+16+i*4])[0])

            # stco/co64
            stco = find_box(moov_data, 'stco', stbl[2], stbl_end)
            co64 = find_box(moov_data, 'co64', stbl[2], stbl_end)
            offsets = []
            if co64:
                cd = co64[2]
                cnt = struct.unpack('>I', moov_data[cd+4:cd+8])[0]
                for i in range(min(cnt, 10)):
                    offsets.append(struct.unpack('>Q', moov_data[cd+8+i*8:cd+16+i*8])[0])
            elif stco:
                cd = stco[2]
                cnt = struct.unpack('>I', moov_data[cd+4:cd+8])[0]
                for i in range(min(cnt, 10)):
                    offsets.append(struct.unpack('>I', moov_data[cd+8+i*4:cd+12+i*4])[0])

            # stsc
            stsc = find_box(moov_data, 'stsc', stbl[2], stbl_end)
            stsc_entries = []
            if stsc:
                cd = stsc[2]
                cnt = struct.unpack('>I', moov_data[cd+4:cd+8])[0]
                for i in range(cnt):
                    fc = struct.unpack('>I', moov_data[cd+8+i*12:cd+12+i*12])[0]
                    spc = struct.unpack('>I', moov_data[cd+12+i*12:cd+16+i*12])[0]
                    di = struct.unpack('>I', moov_data[cd+16+i*12:cd+20+i*12])[0]
                    stsc_entries.append((fc, spc, di))

            # Compute sample offsets
            sample_offsets = []
            sample_sizes_all = []
            if default_size:
                all_sizes = [default_size] * sample_count
            else:
                all_sizes = []
                for i in range(sample_count):
                    all_sizes.append(struct.unpack('>I', moov_data[d+12+i*4:d+16+i*4])[0])

            sample_idx = 0
            for chunk_idx in range(len(offsets)):
                chunk_num = chunk_idx + 1
                spc = 1
                for fc, s, _ in stsc_entries:
                    if fc <= chunk_num:
                        spc = s
                    else:
                        break
                off = offsets[chunk_idx]
                for s in range(spc):
                    if sample_idx >= sample_count:
                        break
                    sample_offsets.append(off)
                    sample_sizes_all.append(all_sizes[sample_idx])
                    off += all_sizes[sample_idx]
                    sample_idx += 1

            # Read the first few samples from disk
            with open(filepath, 'rb') as f:
                for i in range(min(5, len(sample_offsets))):
                    off = sample_offsets[i]
                    sz = sample_sizes_all[i]
                    f.seek(off)
                    pkt = f.read(sz)

                    if sz < 100:
                        # Init packet
                        print(f"\n  Sample {i}: INIT PACKET ({sz} bytes) at file offset {off}")
                        result = decode_init_packet(pkt)
                        print(f"    hex: {result['hex']}")
                        print(f"    raw bytes: {result['raw_bytes']}")
                        print(f"    as u32[0..2]: {result['as_u32']}")
                        print(f"    as u16[0..6]: {result['as_u16']}")
                        print(f"    as u8:  {result['as_u8']}")
                        interp = result['interpretation']
                        print(f"    >> Interpretation (data packet preamble format):")
                        print(f"       [0:4]  zero_pad:       {interp['zero_pad_0_3']}")
                        print(f"       [4:8]  timestamp:      {interp['timestamp_100ns']}  ({interp['timestamp_100ns']/10_000_000:.6f} sec)")
                        print(f"       [8]    flags:          0x{interp['flags_byte8']:02X}")
                        print(f"       [9:12] pad:            {interp['zero_pad_9_11']}")
                        print(f"       [12:14] format_id:     {interp['format_id']}")
                        if 'extra_bytes' in result:
                            print(f"    extra bytes ({result['extra_size']}): {result['extra_bytes']}")
                    else:
                        # Data packet
                        print(f"\n  Sample {i}: DATA PACKET ({sz} bytes) at file offset {off}")
                        preamble = decode_data_packet_preamble(pkt)
                        print(f"    preamble:")
                        print(f"      [0:4]  zero_pad:     {preamble['zero_pad']}")
                        print(f"      [4:8]  timestamp:    {preamble['timestamp_100ns_ticks']} ticks  ({preamble['timestamp_seconds']:.6f} sec)")
                        print(f"      [8]    flags:        0x{preamble['flags']:02X}")
                        print(f"      [9:12] pad:          {preamble['pad_9_11']}")
                        print(f"      [12:14] format_id:   {preamble['format_id']}")

            # Also get the mdhd timescale for this track
            mdhd = find_box(moov_data, 'mdhd', mdia[2], mdia_end)
            data_timescale = None
            if mdhd:
                mdhd_info = parse_mdhd(moov_data, mdhd[2], mdhd[1])
                data_timescale = mdhd_info['timescale']

            # Get the stts for this track
            stts = find_box(moov_data, 'stts', stbl[2], stbl_end)
            if stts:
                stts_entries = parse_stts(moov_data, stts[2], stts[1])
                # Compute first sample's decode time (always 0 in stts, but check)
                print(f"\n  Data track stts: first delta = {stts_entries[0]['delta'] if stts_entries else 'N/A'}")
                if data_timescale and stts_entries:
                    print(f"    = {stts_entries[0]['delta'] / data_timescale:.6f} sec")

            break

    # ── Cross-track timing summary ──
    print(f"\n{'='*70}")
    print(f"  CROSS-TRACK TIMING SUMMARY")
    print(f"{'='*70}")

    track_num = 0
    for off, sz, btype, dstart in iter_boxes(moov_data, moov_data_start, len(moov_data)):
        if btype == 'trak':
            track_num += 1
            trak_end = off + sz
            mdia = find_box(moov_data, 'mdia', dstart, trak_end)
            if not mdia:
                continue
            mdia_end = mdia[0] + mdia[1]

            hdlr = find_box(moov_data, 'hdlr', mdia[2], mdia_end)
            handler = '????'
            if hdlr:
                handler = parse_hdlr(moov_data, hdlr[2], hdlr[1])['handler_type']

            mdhd = find_box(moov_data, 'mdhd', mdia[2], mdia_end)
            ts = None
            dur = None
            if mdhd:
                mdhd_info = parse_mdhd(moov_data, mdhd[2], mdhd[1])
                ts = mdhd_info['timescale']
                dur = mdhd_info['duration']

            # edts/elst
            edts = find_box(moov_data, 'edts', dstart, trak_end)
            elst_info = None
            if edts:
                elst = find_box(moov_data, 'elst', edts[2], edts[0]+edts[1])
                if elst:
                    elst_info = parse_elst(moov_data, elst[2], elst[1])

            print(f"\n  Track {track_num} ({handler}):")
            if ts and dur:
                print(f"    mdhd: timescale={ts}, duration={dur} ({dur/ts:.6f} sec)")
            if elst_info:
                for e in elst_info['entries']:
                    mt = e['media_time']
                    sd = e['segment_duration']
                    sd_sec = sd / mvhd_timescale if mvhd_timescale else 0
                    mt_sec = mt / ts if ts and mt >= 0 else mt
                    print(f"    elst: segment_duration={sd} ({sd_sec:.6f}s)  media_time={mt} ({mt_sec:.6f}s)" if mt >= 0 else
                          f"    elst: segment_duration={sd} ({sd_sec:.6f}s)  media_time={mt} (empty edit = delay)")
            else:
                print(f"    elst: NONE")


if __name__ == '__main__':
    main()
