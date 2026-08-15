"""Fuse Carry_emote.glb (left/carry arm) with idle.glb (everything else).

Output: CarryIdle_emote.glb — carry file as the base (skeleton, meshes, node
indices untouched), with the animation channels re-pointed:
  - left arm chain (shoulder->fingers): carry's own keys, loop-extended 1s -> 2s
  - every other bone idle animates:     idle's keys (2s) lifted in by bone name
  - bones idle lacks (fingertip 4s, toes): carry's keys, loop-extended
"""
import json, struct, sys

CARRY = '/Users/kj/Desktop/GitHub/CleanTheClub/assets/scene/Emotes/Carry_emote.glb'
IDLE  = '/Users/kj/Desktop/idle.glb'
OUT   = '/Users/kj/Desktop/GitHub/CleanTheClub/assets/scene/Emotes/CarryIdle_emote.glb'

CARRY_KEEP_EXACT = {'Avatar_LeftShoulder', 'Avatar_LeftArm', 'Avatar_LeftForeArm'}
def is_carry_arm(bone):
    return bone in CARRY_KEEP_EXACT or bone.startswith('Avatar_LeftHand')

def load_glb(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'glTF'
    jlen = struct.unpack('<I', d[12:16])[0]
    j = json.loads(d[20:20 + jlen])
    off = 20 + jlen
    off += (4 - (jlen % 4)) % 4  # JSON chunk is padded to 4
    blen = struct.unpack('<I', d[off:off + 4])[0]
    assert d[off + 4:off + 8] == b'BIN\x00'
    return j, bytearray(d[off + 8:off + 8 + blen])

def read_accessor(j, bin_, idx):
    a = j['accessors'][idx]
    assert a['componentType'] == 5126, f'accessor {idx} not float32'
    ncomp = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    bv = j['bufferViews'][a['bufferView']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = a['count'] * ncomp
    vals = struct.unpack_from(f'<{n}f', bin_, start)
    return list(vals), ncomp

cj, cbin = load_glb(CARRY)
ij, ibin = load_glb(IDLE)

canim = cj['animations'][0]
ianim = ij['animations'][0]

# idle data by (bone, path)
idle_data = {}
for ch in ianim['channels']:
    bone = ij['nodes'][ch['target']['node']].get('name')
    path = ch['target']['path']
    s = ianim['samplers'][ch['sampler']]
    inp, _ = read_accessor(ij, ibin, s['input'])
    out, ncomp = read_accessor(ij, ibin, s['output'])
    idle_data[(bone, path)] = (inp, out, ncomp, s.get('interpolation', 'LINEAR'))

IDLE_DUR = max(v[0][-1] for v in idle_data.values())

def loop_extend(inp, out, ncomp, target_dur):
    """Tile a looped clip until target_dur (assumes first==last frame pose)."""
    dur = inp[-1] - inp[0]
    ninp, nout = list(inp), list(out)
    while ninp[-1] < target_dur - 1e-6:
        base = ninp[-1]
        # skip source key 0 (same pose as our current last key)
        for i in range(1, len(inp)):
            t = base + (inp[i] - inp[0])
            if t > target_dur + 1e-6: break
            ninp.append(t)
            nout.extend(out[i * ncomp:(i + 1) * ncomp])
        if dur <= 1e-6: break
    return ninp, nout

# append new data to carry BIN; build accessors/bufferViews
def align4(buf):
    while len(buf) % 4: buf.append(0)

def add_accessor(vals, ncomp, with_minmax):
    align4(cbin)
    bv_idx = len(cj['bufferViews'])
    byte_off = len(cbin)
    cbin.extend(struct.pack(f'<{len(vals)}f', *vals))
    cj['bufferViews'].append({'buffer': 0, 'byteOffset': byte_off, 'byteLength': len(vals) * 4})
    acc = {
        'bufferView': bv_idx, 'componentType': 5126,
        'count': len(vals) // ncomp,
        'type': {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4'}[ncomp],
    }
    if with_minmax:
        acc['min'] = [min(vals)]
        acc['max'] = [max(vals)]
    cj['accessors'].append(acc)
    return len(cj['accessors']) - 1

stats = {'carry_arm': 0, 'idle': 0, 'carry_looped': 0}
for ch in canim['channels']:
    bone = cj['nodes'][ch['target']['node']].get('name')
    path = ch['target']['path']
    s = canim['samplers'][ch['sampler']]
    if is_carry_arm(bone) or (bone, path) not in idle_data:
        inp, _ = read_accessor(cj, cbin, s['input'])
        out, ncomp = read_accessor(cj, cbin, s['output'])
        ninp, nout = loop_extend(inp, out, ncomp, IDLE_DUR)
        stats['carry_arm' if is_carry_arm(bone) else 'carry_looped'] += 1
    else:
        ninp, nout, ncomp, interp = idle_data[(bone, path)]
        s['interpolation'] = interp
        stats['idle'] += 1
    s['input'] = add_accessor(ninp, 1, True)
    s['output'] = add_accessor(nout, ncomp, False)

canim['name'] = 'CarryIdle_Animation'
cj['buffers'][0]['byteLength'] = len(cbin)

# write GLB
jbytes = json.dumps(cj, separators=(',', ':')).encode()
while len(jbytes) % 4: jbytes += b' '
align4(cbin)
total = 12 + 8 + len(jbytes) + 8 + len(cbin)
with open(OUT, 'wb') as f:
    f.write(struct.pack('<4sII', b'glTF', 2, total))
    f.write(struct.pack('<II', len(jbytes), 0x4E4F534A)); f.write(jbytes)
    f.write(struct.pack('<II', len(cbin), 0x004E4942)); f.write(bytes(cbin))

print(f'channels: {stats}, idle duration {IDLE_DUR}s -> {OUT}')
