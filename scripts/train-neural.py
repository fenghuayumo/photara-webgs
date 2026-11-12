"""Train Photara's tiny spatial kernel predictor from scratch, no external weights.

Input: own renderer's paired PNGs from export-neural-training.mjs.
The third camera is held out; synthetic coverage patches broaden the training
distribution. This is a local experimental model, not a generalization claim.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
import torch
import torch.nn.functional as F

parser = argparse.ArgumentParser()
parser.add_argument('--data', default='test-results/neural-training')
parser.add_argument('--output', default='src/neural-weights.json')
parser.add_argument('--steps', type=int, default=2500)
args = parser.parse_args()
if args.steps < 1:
    parser.error('--steps must be positive')
torch.manual_seed(82731)
device = 'cuda' if torch.cuda.is_available() else 'cpu'
torch.set_num_threads(4)


def features(patches):
    # [B,3,5,5]: nine immediate RGB candidates plus a wider tent mean.
    taps = patches[:, :, 1:4, 1:4].flatten(2).transpose(1, 2)
    tent = torch.tensor([1., 2., 1.], device=device)
    kernel = torch.outer(tent, tent).reshape(1, 9, 1) / 16
    wide = (patches[:, :, ::2, ::2].flatten(2).transpose(1, 2) * kernel).sum(1)
    luma = (taps * torch.tensor([.2126, .7152, .0722], device=device)).sum(2)
    variance = (luma.square().mean(1) - luma.mean(1).square()).clamp_min(0)
    inputs = torch.cat([luma, taps[:, 4], wide, variance[:, None]], 1)
    return inputs, taps, wide


def load_pairs():
    train, validation = [], []
    for file in sorted(Path(args.data).glob('*-noisy.png')):
        raw = torch.from_numpy(np.array(Image.open(file).convert('RGB')).copy()).to(device).permute(2, 0, 1).float()/255
        clean = torch.from_numpy(np.array(Image.open(str(file).replace('-noisy', '-target')).convert('RGB')).copy()).to(device).permute(2, 0, 1).float()/255
        h, w = raw.shape[1:]
        count = 3000
        x = torch.randint(2, w-2, (count,), device=device)
        y = torch.randint(2, h-2, (count,), device=device)
        offsets = torch.arange(-2, 3, device=device)
        patches = raw[:, y[:, None, None]+offsets[None, :, None], x[:, None, None]+offsets[None, None, :]].permute(1, 0, 2, 3)
        target = clean[:, y, x].T
        (validation if file.name.startswith('2-') else train).append((patches, target))
    return [tuple(torch.cat([pair[k] for pair in split]) for k in [0, 1]) for split in [train, validation]]


def synthetic(batch):
    axis = torch.arange(-2, 3, device=device).float()
    yy, xx = torch.meshgrid(axis, axis, indexing='ij')
    theta = torch.rand(batch, 1, 1, device=device)*6.283
    coordinate = xx*theta.cos()+yy*theta.sin()-torch.randn(batch, 1, 1, device=device)
    width = .15+torch.rand(batch, 1, 1, device=device)*2
    alpha = torch.exp(-.5*(coordinate/width).square())*torch.rand(batch, 1, 1, device=device)
    edge = (coordinate>0).float()*torch.rand(batch, 1, 1, device=device)
    alpha = torch.where(torch.rand(batch, 1, 1, device=device)>.5, alpha, edge)
    fg, bg = [torch.rand(batch, 3, 1, 1, device=device) for _ in range(2)]
    kept = (torch.rand(batch, 1, 5, 5, device=device)<alpha[:, None]).float()
    raw = kept*fg+(1-kept)*bg
    target = alpha[:, 2, 2, None]*fg[:, :, 0, 0]+(1-alpha[:, 2, 2, None])*bg[:, :, 0, 0]
    return raw, target


train, validation = load_pairs()
network = torch.nn.Sequential(torch.nn.Linear(16, 24), torch.nn.SiLU(), torch.nn.Linear(24, 10)).to(device)
torch.nn.init.zeros_(network[-1].weight)
torch.nn.init.zeros_(network[-1].bias)
optimizer = torch.optim.Adam(network.parameters(), lr=.002)


def predict(patches):
    inputs, taps, wide = features(patches)
    prediction = network(inputs)
    local = (prediction[:, :9].softmax(1)[:, :, None]*taps).sum(1)
    return torch.lerp(local, wide, prediction[:, 9:].sigmoid())


for step in range(args.steps):
    indices = torch.randint(len(train[0]), (2048,), device=device)
    real, target = train[0][indices], train[1][indices]
    procedural, truth = synthetic(1024)
    raw, clean = torch.cat([real, procedural]), torch.cat([target, truth])
    prediction = predict(raw)
    # L2 penalizes bright speckles; L1 limits smoothing across fine structure.
    loss = F.mse_loss(prediction, clean)+.1*F.l1_loss(prediction, clean)
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    optimizer.step()
    if step%500 == 0:
        print(json.dumps({'step':step,'loss':loss.item()}), flush=True)
with torch.no_grad():
    prediction = predict(validation[0])
    mae = (prediction-validation[1]).abs().mean().item()*255
    raw_mae = (validation[0][:, :, 2, 2]-validation[1]).abs().mean().item()*255
digest = hashlib.sha256()
for file in sorted(Path(args.data).glob('*.png')):
    digest.update(file.name.encode())
    digest.update(file.read_bytes())
model = {'version':1,'seed':82731,'inputs':16,'hidden':24,'outputs':10,
         'training':{'steps':args.steps,'realPatches':len(train[0]),'heldOutPatches':len(validation[0]),'heldOutMAE':mae,'heldOutRawMAE':raw_mae,'scope':'one local scene, camera 2 held out; synthetic coverage patches; trained from scratch'},
         'layers':[{'w':network[i].weight.detach().cpu().flatten().tolist(),'b':network[i].bias.detach().cpu().tolist()} for i in [0, 2]]}
model['training']['dataSha256'] = digest.hexdigest()
Path(args.output).write_text(json.dumps(model, separators=(',', ':'))+'\n', encoding='utf-8')
print(json.dumps(model['training']), flush=True)
