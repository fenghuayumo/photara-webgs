"""Generate synthetic SOG-XT compatibility assets with Studio's executable."""
import argparse
import json
import math
from pathlib import Path
import shutil
import struct
import subprocess
import zipfile
import yaml

parser = argparse.ArgumentParser()
parser.add_argument('--native', required=True, type=Path)
args = parser.parse_args()
native = args.native.resolve(strict=True)
root = Path(__file__).resolve().parents[1]
temporary = root / 'test-results' / 'sog-xt-native'
output = root / 'tests' / 'fixtures' / 'sog-xt'
temporary.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True, exist_ok=True)


def run(*arguments):
    subprocess.run([str(native), *map(str, arguments)], check=True, cwd=native.parent)


for degree in range(4):
    bases = (degree + 1)**2
    fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2']
    fields += ['f_rest_' + str(i) for i in range((bases-1)*3)]
    fields += ['opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    header = ['ply', 'format binary_little_endian 1.0',
              'comment photara_filter_mode ' + ('mip2d' if degree % 2 else 'classic'),
              'element vertex 17'] + ['property float ' + field for field in fields] + ['end_header']
    payload = bytearray()
    for i in range(17):
        values = [(i % 5 - 2)*.15, (i//5 - 1.5)*.17, 2+i*.025]
        values += [.1+.01*i, -.1+.02*i, .2-.01*i]
        values += [math.sin(i*.7+k*.3)*.2 for k in range((bases-1)*3)]
        values += [-1+i*.1, -2.5, -2.3, -2.8, math.cos(i*.05), 0, math.sin(i*.05), 0]
        payload.extend(struct.pack('<' + str(len(values)) + 'f', *values))
    source = temporary / f'source-{degree}.ply'
    source.write_bytes(('\n'.join(header)+'\n').encode() + payload)
    target = temporary / f'degree{degree}'
    run('--sog-xt-benchmark', source, target)
    shutil.copyfile(target / 'benchmark.sog-xt', output / f'degree{degree}.sog-xt')
    shutil.copyfile(target / 'decoded-sog-xt.ply', output / f'degree{degree}.ply')

with zipfile.ZipFile(output / 'degree3.sog-xt') as archive:
    split = output / 'unbundled'
    split.mkdir(exist_ok=True)
    for name in archive.namelist():
        if Path(name).name != name or not (name.endswith('.webp') or name == 'container_meta.yaml'):
            raise ValueError('Unexpected native asset name')
        (split / name).write_bytes(archive.read(name))
    metadata = json.loads(archive.read('container_meta.yaml'))
    metadata.pop('format')
    metadata.pop('version')
    for name in ['count', 'sh_degree', 'antialiased']:
        metadata['meta'].pop(name, None)
    for operation in metadata['ops']:
        for transform in operation['transforms']:
            transform.get('simple_quantize', {}).pop('levels', None)
    reference = yaml.safe_dump(metadata, sort_keys=True).encode()
    (output / 'reference.yaml').write_bytes(reference)
    (split / 'reference.yaml').write_bytes(reference)
    with zipfile.ZipFile(output / 'reference.sog-xt', 'w', compression=zipfile.ZIP_DEFLATED) as destination:
        destination.writestr('container_meta.yaml', reference)
        for name in archive.namelist():
            if name != 'container_meta.yaml':
                destination.writestr(name, archive.read(name))
run('--decode-sog-xt', output / 'reference.sog-xt', output / 'reference.ply')

with zipfile.ZipFile(output / 'degree1.sog-xt') as archive, zipfile.ZipFile(output / 'v1-degree1.sog-xt', 'w') as destination:
    metadata = json.loads(archive.read('container_meta.yaml'))
    metadata['version'] = 1
    for operation in metadata['ops']:
        if operation['input_fields'] == ['f_rest_centroids']:
            quantizer = operation['transforms'][0]['simple_quantize']
            for key in ['min_values', 'max_values']:
                quantizer[key] = [quantizer[key][c*15+b] for b in range(3) for c in range(3)]
    destination.writestr('container_meta.yaml', json.dumps(metadata))
    for name in archive.namelist():
        if name != 'container_meta.yaml':
            destination.writestr(name, archive.read(name))
run('--decode-sog-xt', output / 'v1-degree1.sog-xt', output / 'v1-degree1.ply')
