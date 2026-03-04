#!/usr/bin/env python3
"""
Analyze stts drift between video and data tracks.
Shows how the cumulative time offset evolves over the recording.
"""

import struct
import sys
import os

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
    while offset < end - 8:
        r = read_box_header(data, offset)
        if r is None or r[0] < 8:
            break
        size, btype, hdr, data_start = r
        yield offset, size, btype, data_start
        offset += size

def parse_stts(data, offset):
    d = offset
    entry_count = struct.unpack('>I', data[d+4:d+8])[0]
    entries = []
    pos = d + 8
    for i in range(entry_count):
        sample_count = struct.unpack('>I', data[pos:pos+4])[0]
        sample_delta = struct.unpack('>I', data[pos+4:pos+8])[0]
        entries.append((sample_count, sample_delta))
        pos += 8
    return entries

def expand_stts(entries):
    """Expand run-length-encoded stts into per-sample deltas."""
    deltas = []
    for count, delta in entries:
        deltas.extend([delta] * count)
    return deltas

def main():
    filepath = sys.argv[1] if len(sys.argv) > 1 else 'ADV_0600.mp4'
    filesize = os.path.getsize(filepath)

    # Find moov
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
                size = struct.unpack('>Q', hdr_data[8:16])[0]
            elif size == 0:
                size = filesize - pos
            if btype == 'moov':
                f.seek(pos)
                moov_data = f.read(size)
                break
            pos += size
        else:
            print("ERROR: no moov")
            sys.exit(1)

    moov_hdr = read_box_header(moov_data, 0)
    moov_start = moov_hdr[3]

    # Collect track info
    tracks = {}
    for off, sz, btype, dstart in iter_boxes(moov_data, moov_start, len(moov_data)):
        if btype != 'trak':
            continue
        trak_end = off + sz
        mdia = find_box(moov_data, 'mdia', dstart, trak_end)
        if not mdia:
            continue
        mdia_end = mdia[0] + mdia[1]

        # handler
        hdlr = find_box(moov_data, 'hdlr', mdia[2], mdia_end)
        if not hdlr:
            continue
        handler = moov_data[hdlr[2]+8:hdlr[2]+12].decode('ascii', errors='replace')

        # mdhd timescale
        mdhd = find_box(moov_data, 'mdhd', mdia[2], mdia_end)
        if not mdhd:
            continue
        d = mdhd[2]
        version = moov_data[d]
        if version == 0:
            timescale = struct.unpack('>I', moov_data[d+12:d+16])[0]
        else:
            timescale = struct.unpack('>I', moov_data[d+20:d+24])[0]

        # stts
        minf = find_box(moov_data, 'minf', mdia[2], mdia_end)
        if not minf:
            continue
        stbl = find_box(moov_data, 'stbl', minf[2], minf[0]+minf[1])
        if not stbl:
            continue
        stts = find_box(moov_data, 'stts', stbl[2], stbl[0]+stbl[1])
        if not stts:
            continue
        entries = parse_stts(moov_data, stts[2])

        # elst
        edts = find_box(moov_data, 'edts', dstart, trak_end)
        elst_delay = 0.0
        if edts:
            elst = find_box(moov_data, 'elst', edts[2], edts[0]+edts[1])
            if elst:
                d2 = elst[2]
                ver = moov_data[d2]
                n = struct.unpack('>I', moov_data[d2+4:d2+8])[0]
                pos2 = d2 + 8
                # mvhd timescale
                mvhd = find_box(moov_data, 'mvhd', moov_start, len(moov_data))
                mvhd_ts = 3000
                if mvhd:
                    mvhd_ts = struct.unpack('>I', moov_data[mvhd[2]+12:mvhd[2]+16])[0]
                for _ in range(n):
                    if ver == 0:
                        sd = struct.unpack('>I', moov_data[pos2:pos2+4])[0]
                        mt = struct.unpack('>i', moov_data[pos2+4:pos2+8])[0]
                        pos2 += 12
                    else:
                        sd = struct.unpack('>Q', moov_data[pos2:pos2+8])[0]
                        mt = struct.unpack('>q', moov_data[pos2+8:pos2+16])[0]
                        pos2 += 20
                    if mt == -1:
                        elst_delay += sd / mvhd_ts
                        break

        tracks[handler] = {
            'timescale': timescale,
            'stts': entries,
            'elst_delay': elst_delay,
        }

    print("=" * 70)
    print("  TRACK TIMING COMPARISON")
    print("=" * 70)

    for handler, info in sorted(tracks.items()):
        deltas = expand_stts(info['stts'])
        total_samples = len(deltas)
        ts = info['timescale']
        deltas_sec = [d / ts for d in deltas]

        print(f"\n  {handler}: {total_samples} samples, timescale={ts}")
        print(f"    elst delay: {info['elst_delay']:.6f} sec")
        print(f"    stts delta range: {min(deltas)}-{max(deltas)} ticks")
        print(f"    stts delta range: {min(deltas)/ts:.6f}-{max(deltas)/ts:.6f} sec")
        print(f"    mean delta: {sum(deltas)/len(deltas)/ts:.6f} sec")
        print(f"    total duration: {sum(deltas)/ts:.6f} sec")

    # Now the key analysis: cumulative time comparison
    if 'vide' in tracks and 'adrv' in tracks:
        v = tracks['vide']
        d = tracks['adrv']

        v_deltas = expand_stts(v['stts'])
        d_deltas = expand_stts(d['stts'])

        v_ts = v['timescale']
        d_ts = d['timescale']

        # Build cumulative presentation time arrays
        # (accounting for edit list delays)
        v_times = [v['elst_delay']]
        for delta in v_deltas:
            v_times.append(v_times[-1] + delta / v_ts)

        d_times = [d['elst_delay']]
        for delta in d_deltas:
            d_times.append(d_times[-1] + delta / d_ts)

        print(f"\n{'='*70}")
        print(f"  VIDEO vs DATA TRACK CUMULATIVE TIMING")
        print(f"{'='*70}")
        print(f"\n  Video: {len(v_deltas)} samples, starts at {v_times[0]:.6f}s")
        print(f"  Data:  {len(d_deltas)} samples, starts at {d_times[0]:.6f}s")
        print(f"  Start offset (data - video): {d_times[0] - v_times[0]:.6f}s")

        print(f"\n  Data track first 20 sample presentation times:")
        for i in range(min(20, len(d_times))):
            delta_str = f"  (delta={d_deltas[i]/d_ts:.3f}s)" if i < len(d_deltas) else ""
            print(f"    sample {i:3d}: {d_times[i]:.6f}s{delta_str}")

        print(f"\n  Video track first 20 sample presentation times:")
        for i in range(min(20, len(v_times))):
            delta_str = f"  (delta={v_deltas[i]/v_ts:.6f}s)" if i < len(v_deltas) else ""
            print(f"    frame {i:3d}: {v_times[i]:.6f}s{delta_str}")

        # Show per-second drift
        print(f"\n  Data track sample duration histogram (seconds):")
        import collections
        d_sec_bins = collections.Counter()
        for delta in d_deltas:
            sec = round(delta / d_ts, 3)
            d_sec_bins[sec] += 1
        for sec, count in sorted(d_sec_bins.items()):
            bar = '#' * min(count, 60)
            print(f"    {sec:7.3f}s: {count:4d} {bar}")

        # Cumulative drift at 10-second intervals
        print(f"\n  Cumulative drift (data_time - video_time) at data sample boundaries:")
        print(f"  (negative = data track lags video)")
        # For each data sample, find the corresponding video time
        # Data sample i starts at d_times[i], find nearest video frame
        for i in range(0, len(d_times), 10):
            if i >= len(d_times):
                break
            dt = d_times[i]
            # The "expected" time is just the data packet index in seconds
            # (since each packet should be 1 second)
            expected = d['elst_delay'] + (i - 1 if i > 0 else 0)  # sample 0 is init
            drift = dt - expected if i > 0 else 0
            print(f"    sample {i:4d}: presentation_time={dt:10.3f}s  expected={expected:10.3f}s  drift={drift:+.3f}s")


if __name__ == '__main__':
    main()
