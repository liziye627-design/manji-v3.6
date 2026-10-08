/* Original layered Canvas 2D puppy artwork. All pose distances use a 512 px artboard. */
const BREEDS = {
  shiba: { fur: '#E6A05F', light: '#F4BD7C', shade: '#CD804A', cream: '#FFF0D4', ink: '#795440', ear: '#D98971', nose: '#4F3B32', iris: '#69483C', collar: '#C96958' },
  husky: { fur: '#899BAA', light: '#B0BDC7', shade: '#687E91', cream: '#F4F3E6', ink: '#506270', ear: '#D79A9D', nose: '#36454E', iris: '#77B9D4', collar: '#729B93' },
  pug: { fur: '#DCC29A', light: '#EBD7B4', shade: '#C0A079', cream: '#F6E8CD', ink: '#77604A', ear: '#786052', nose: '#493B35', iris: '#896D50', collar: '#7F9B80' },
};

const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, Number(n) || 0));
const mix = (a, b, t) => a + (b - a) * t;

function shape(c, path, fill, stroke, width = 4) {
  const p = new Path2D(path);
  if (fill) { c.fillStyle = fill; c.fill(p); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(p); }
}

function oval(c, x, y, rx, ry, fill, stroke, width = 3, rotate = 0) {
  c.beginPath(); c.ellipse(x, y, rx, ry, rotate, 0, Math.PI * 2);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = width; c.stroke(); }
}

function stroke(c, path, color, width = 3) { shape(c, path, null, color, width); }

function withPivot(c, x, y, rotation, sx, sy, paint) {
  c.save(); c.translate(x, y); c.rotate(rotation); c.scale(sx, sy); c.translate(-x, -y); paint(); c.restore();
}

function heart(c, x, y, scale, color) {
  c.save(); c.translate(x, y); c.scale(scale, scale);
  shape(c, 'M0 8 C-21 -5 -18 -23 -6 -22 C-2 -22 0 -19 0 -17 C4 -25 16 -24 19 -15 C22 -7 11 2 0 8Z', color);
  stroke(c, 'M-12 -14 Q-13 -18 -8 -18', '#FFF8EE', 2.8); c.restore();
}

function star(c, x, y, r, color) {
  c.save(); c.translate(x, y);
  shape(c, `M0 ${-r} Q${r * .15} ${-r * .12} ${r} 0 Q${r * .16} ${r * .14} 0 ${r} Q${-r * .14} ${r * .12} ${-r} 0 Q${-r * .14} ${-r * .14} 0 ${-r}Z`, color);
  c.restore();
}

function drawTail(c, b, p, lie) {
  const wag = clamp(p.tailWag, -.9, .9);
  c.save(); c.translate(329 + lie * 18, 390 + lie * 26); c.rotate(wag - lie * .42);
  if (b === BREEDS.pug) {
    shape(c, 'M-7 14 C17 9 47 -5 43 -32 C40 -57 3 -65 -5 -43 C-12 -25 13 -13 22 -27 C27 -35 19 -43 13 -36 C11 -31 12 -29 16 -29 C10 -19 -2 -24 -5 -15 L-7 14Z', b.fur, b.ink, 4.1);
    stroke(c, 'M-1 3 C24 -2 35 -17 33 -32', b.light, 7);
  } else {
    shape(c, 'M-9 18 C13 23 42 11 52 -14 C66 -49 43 -73 15 -70 C-7 -69 -25 -51 -21 -29 C-20 -15 -4 -6 7 -14 C18 -22 11 -37 2 -31 C1 -47 22 -48 27 -34 C34 -16 12 -5 -5 -6Z', b.fur, b.ink, 4.3);
    shape(c, 'M13 -69 C32 -72 51 -61 55 -44 C48 -49 43 -43 38 -39 C31 -37 31 -29 27 -27 C30 -45 12 -51 2 -42 C-6 -38 -8 -29 -4 -24 C-18 -28 -19 -44 -12 -53 C-6 -62 3 -67 13 -69Z', b.cream);
    stroke(c, 'M-9 10 Q21 11 35 -8', b.shade, 3);
    stroke(c, 'M28 -61 Q44 -57 48 -47', '#FFFFFF75', 3);
  }
  c.restore();
}

function paw(c, b, x, y, rotation = 0, broad = 1) {
  c.save(); c.translate(x, y); c.rotate(rotation); c.scale(broad, 1);
  shape(c, 'M-25 -11 C-31 -6 -34 4 -29 11 C-20 19 18 20 28 12 C35 5 31 -7 22 -13 C10 -20 -14 -19 -25 -11Z', b.cream, b.ink, 3.6);
  stroke(c, 'M-10 5 Q-12 10 -10 14 M6 5 Q4 10 6 15', b.shade, 2.4);
  oval(c, -14, -7, 9, 3, '#FFFFFF90');
  c.restore();
}

function drawBody(c, b, p, lie, sit) {
  const stretch = clamp(p.stretch);
  const cycle = Number(p.legCycle) || 0;
  const stride = Math.sin(cycle) * 8;
  drawTail(c, b, p, lie);
  withPivot(c, 256 + lie * 22, 419, (Number(p.bodyTilt) || 0) * .55, 1 + lie * .38, 1 - lie * .36, () => {
    // The rear haunches and separate toe-tipped hind paws remain behind the torso.
    oval(c, 205, 416 - sit * 7 - stretch * 19, 36 + sit * 8, 38, b.shade, b.ink, 3.7, -.25);
    oval(c, 305, 416 - sit * 7 - stretch * 19, 36 + sit * 8, 38, b.shade, b.ink, 3.7, .25);
    paw(c, b, 201, 445 + stride * .5, -.06, 1.05);
    paw(c, b, 309, 445 - stride * .5, .06, 1.05);
    shape(c, 'M204 342 C205 313 230 303 255 306 C284 300 309 316 310 343 C312 365 329 388 323 412 C317 436 290 444 257 443 C222 444 193 435 188 412 C184 388 201 369 204 342Z', b.fur, b.ink, 4.3);
    shape(c, 'M210 345 C211 325 231 315 255 316 C281 310 301 327 299 345 C297 366 305 383 305 397 C306 412 287 424 259 426 C235 426 218 422 205 408 C199 392 212 366 210 345Z', b.light);
    // A scalloped soft chest bib, kept as a flat illustration rather than a shaded sphere.
    shape(c, 'M221 329 Q255 313 290 329 C283 345 292 365 289 382 L280 377 L277 394 L267 389 L255 406 L245 391 L235 397 L232 381 L219 385 C219 365 227 347 221 329Z', b.cream);
    stroke(c, 'M245 357 Q251 362 255 358 M259 373 L255 381 L252 375', '#D3BA9660', 2.4);
    // Forelegs pivot independently at their shoulders; positive values wave outwards.
    const legs = [
      { x: 218, sign: -1, lift: clamp(p.leftPaw, -1.7, 2.2), gait: stride },
      { x: 293, sign: 1, lift: clamp(p.rightPaw, -1.7, 2.2), gait: -stride },
    ];
    for (const leg of legs) {
      c.save(); c.translate(leg.x, 351 - stretch * 21); c.rotate(-leg.sign * leg.lift + leg.gait * .014);
      c.scale(1, 1 + stretch * .23);
      shape(c, 'M-18 -3 C-24 17 -25 47 -23 75 C-21 90 17 91 20 76 C23 55 19 16 17 -3', b.fur, b.ink, 3.8);
      shape(c, 'M-21 56 Q0 63 20 57 L20 78 Q3 92 -22 78Z', b.cream);
      stroke(c, 'M-13 14 Q-17 33 -15 48', b.light, 4.6);
      paw(c, b, -1, 90 - sit * 5, -leg.gait * .009);
      if (leg.lift > .45) {
        // Small caramel paw pads become visible during a wave or high-five.
        c.save(); c.globalAlpha *= clamp((leg.lift - .45) * 3.2);
        oval(c, -1, 91, 9, 6, b.ear);
        oval(c, -14, 85, 3.3, 3.8, b.ear); oval(c, 0, 81, 3.2, 3.6, b.ear); oval(c, 12, 85, 3.3, 3.8, b.ear); c.restore();
      }
      c.restore();
    }
  });
}

function drawEars(c, b, breed) {
  if (breed === 'pug') {
    shape(c, 'M167 146 C151 136 133 141 125 154 C124 171 137 192 148 204 C151 208 156 208 159 203 L178 163 Q180 153 167 146Z', b.ear, b.ink, 4.2);
    shape(c, 'M341 146 C357 136 375 141 383 154 C384 171 371 192 360 204 C357 208 352 208 349 203 L330 163 Q328 153 341 146Z', b.ear, b.ink, 4.2);
    shape(c, 'M128 155 Q144 144 160 153 Q144 165 151 193 Q133 177 128 155Z', '#977A64');
    shape(c, 'M380 155 Q364 144 348 153 Q364 165 357 193 Q375 177 380 155Z', '#977A64');
    stroke(c, 'M132 155 Q148 148 160 154 M376 155 Q360 148 348 154', '#BE9F82', 2.9);
    return;
  }
  shape(c, 'M132 188 C126 154 122 110 142 67 C145 60 151 62 156 67 C184 83 206 112 214 143Z', b.fur, b.ink, 4.6);
  shape(c, 'M377 188 C383 154 387 110 367 67 C364 60 358 62 353 67 C325 83 303 112 295 143Z', b.fur, b.ink, 4.6);
  shape(c, 'M144 150 Q137 112 149 84 Q175 103 186 128 Q164 132 144 150Z', b.ear);
  shape(c, 'M365 150 Q372 112 360 84 Q334 103 323 128 Q345 132 365 150Z', b.ear);
  shape(c, 'M144 150 Q145 135 150 128 L155 132 L159 119 L165 127 L174 121 L183 131Z', b.cream);
  shape(c, 'M365 150 Q364 135 359 128 L354 132 L350 119 L344 127 L335 121 L326 131Z', b.cream);
  stroke(c, 'M143 84 Q132 114 136 138 M366 84 Q377 114 373 138', '#FFFFFF45', 3);
}

function eye(c, b, x, y, p, side) {
  const blink = Math.max(clamp(p.blink), clamp(p.sleep));
  const smile = clamp(p.eyeSmile);
  const closed = Math.max(blink, smile);
  c.save(); c.translate(x, y);
  if (closed > .83) {
    stroke(c, smile > blink ? 'M-17 4 Q0 -13 17 4' : 'M-17 0 Q0 12 17 0', b.nose, 4.7);
    stroke(c, side < 0 ? 'M-17 0 L-22 -3' : 'M17 0 L22 -3', b.nose, 2.6);
  } else {
    c.scale(1, Math.max(.11, 1 - closed * .94));
    oval(c, 0, 0, 18, 23, b.nose);
    oval(c, 2 + clamp(p.lookX, -1, 1) * 4, 7, 12, 13, b.iris);
    oval(c, 2 + clamp(p.lookX, -1, 1) * 4, 3, 8, 13, b.nose);
    oval(c, -6, -9, 6.8, 7.1, '#FFFCF1');
    oval(c, 7, 10, 3.4, 3.8, '#FFF9E9');
    oval(c, 10, 0, 1.5, 1.8, '#FFFFFFC0');
    stroke(c, 'M-16 -9 Q-9 -24 4 -23', b.nose, 3.8);
  }
  c.restore();
}

function drawFace(c, b, breed, p) {
  const pug = breed === 'pug';
  if (!pug) drawEars(c, b, breed);
  // Hand-shaped silhouette with cheek tufts and a slightly asymmetric forehead.
  shape(c, 'M256 120 C199 115 156 131 137 169 C123 191 120 216 119 236 L109 250 L117 253 L105 267 L119 269 C115 289 131 310 160 324 C190 340 227 344 256 344 C292 344 330 338 353 325 C378 311 394 291 391 271 L404 266 L391 254 L399 249 L388 236 C388 207 382 186 372 169 C350 132 311 117 256 120Z', b.fur, b.ink, 4.5);
  shape(c, 'M166 166 C190 131 228 129 257 131 C300 130 334 145 350 166 C329 156 306 150 279 151 C237 148 203 151 166 166Z', b.light);
  if (pug) drawEars(c, b, breed);
  if (breed === 'husky') {
    // Two characteristic husky cap points frame a narrow white forehead blaze.
    shape(c, 'M249 122 C243 150 236 158 220 171 C205 184 192 207 188 232 C172 210 158 202 139 206 C141 183 151 162 170 149 C193 130 218 124 249 122Z', b.shade);
    shape(c, 'M263 122 C270 150 276 158 292 171 C307 184 320 207 324 232 C340 210 354 202 373 206 C371 183 361 162 342 149 C319 130 294 124 263 122Z', b.shade);
    shape(c, 'M256 137 C248 156 250 173 236 191 C227 206 236 229 255 238 C278 224 285 207 276 192 C262 174 264 155 256 137Z', b.cream);
  }
  // Cream cheek mask curves around the eyes and joins a soft chin.
  shape(c, 'M130 250 C145 242 155 231 164 220 C170 235 181 244 198 247 C217 248 229 238 241 241 C250 246 263 246 271 241 C284 238 296 248 315 247 C332 244 343 235 349 220 C358 231 369 242 382 250 C391 276 375 304 347 318 C322 331 287 337 256 337 C221 337 190 331 165 318 C138 304 121 277 130 250Z', b.cream);
  if (pug) {
    shape(c, 'M179 224 C195 211 212 216 225 236 C235 244 248 243 256 244 C272 243 280 241 288 234 C301 216 319 213 334 225 C348 244 342 271 332 284 C319 305 291 316 256 316 C222 316 194 305 180 284 C168 268 166 241 179 224Z', '#8B705B');
    shape(c, 'M217 260 C231 248 247 253 256 257 C267 251 280 249 295 260 C307 272 297 290 277 294 C269 297 262 294 256 290 C248 296 239 297 229 292 C212 288 206 274 217 260Z', '#AF9070');
    stroke(c, 'M219 163 Q255 147 291 163 M225 179 Q255 165 285 179 M242 195 Q254 186 267 195', '#AB8B6B', 3.5);
    stroke(c, 'M186 261 Q179 278 192 286 M326 261 Q333 278 320 286', '#69513F', 2.9);
  }
  // Small sesame eyebrows, soft blush and eye highlights carry the expression.
  oval(c, 205, 200, 13, 6, pug ? b.cream : '#FFF2D3', null, 0, -.16);
  oval(c, 305, 200, 13, 6, pug ? b.cream : '#FFF2D3', null, 0, .16);
  c.save(); c.globalAlpha *= .34;
  oval(c, 169, 269, 21, 10, '#EB8D88'); oval(c, 341, 269, 21, 10, '#EB8D88'); c.restore();
  stroke(c, 'M160 267 L158 272 M168 268 L167 273 M175 267 L174 272 M333 267 L332 272 M341 268 L340 273 M348 267 L347 272', '#CD8F7860', 1.8);
  eye(c, b, 207, 238, p, -1); eye(c, b, 304, 238, p, 1);
  if (!pug) {
    oval(c, 236, 281, 22, 15, '#FFF7E4'); oval(c, 276, 281, 22, 15, '#FFF7E4');
  }
  shape(c, 'M244 263 C247 260 264 260 268 263 C273 267 266 277 256 278 C247 276 239 267 244 263Z', b.nose);
  oval(c, 251, 265, 5, 2, '#FFFFFF70');
  stroke(c, 'M256 278 L256 287 M256 286 Q247 294 239 286 M256 286 Q265 294 273 286', b.nose, 2.8);
  const open = clamp(p.mouthOpen);
  if (open > .05) {
    c.save(); c.translate(256, 289); c.scale(1, mix(.2, 1, open));
    shape(c, 'M-15 -2 Q0 8 15 -2 C14 17 8 27 0 27 C-9 27 -14 18 -15 -2Z', b.nose);
    shape(c, 'M-10 17 Q0 9 10 17 C8 26 -8 28 -10 17Z', '#E89B9F');
    stroke(c, 'M0 19 L0 25', '#C67880', 1.6); c.restore();
  } else {
    stroke(c, 'M248 302 Q256 306 264 302', '#D7B28F', 2);
  }
  for (const sign of [-1, 1]) {
    oval(c, 256 + sign * 31, 277, 1.35, 1.3, b.shade);
    oval(c, 256 + sign * 35, 284, 1.2, 1.2, b.shade);
    stroke(c, sign < 0 ? 'M135 279 L145 281 M139 289 L148 290' : 'M377 279 L367 281 M373 289 L364 290', '#D5B897', 2);
  }
  // Collar and small hand-drawn brass bell sit below the fluffy chin.
  shape(c, 'M205 333 Q255 349 307 333 L305 345 Q257 362 207 345Z', b.collar, b.ink, 2.5);
  oval(c, 258, 350, 6, 7, '#E9BD66', b.ink, 2);
  shape(c, 'M244 362 C245 348 270 348 273 362 L276 371 Q257 385 241 371Z', '#E9BD66', b.ink, 2.7);
  shape(c, 'M248 359 Q252 353 258 355 L256 373 Q250 374 247 370Z', '#FFE5A0');
  stroke(c, 'M243 369 Q257 375 274 368', '#B38946', 2);
  oval(c, 258, 369, 2.2, 3, b.ink);
}

/**
 * Draw one transparent, articulated puppy on a square canvas.
 * Supported breeds: shiba, husky, pug. All numeric pose fields are optional.
 * bounce/headY/jump are upward pixels; angles are radians; blend fields are 0..1.
 */
export function drawDog(ctx, breed = 'shiba', pose = {}, size = 768) {
  const breedKey = Object.hasOwn(BREEDS, breed) ? breed : 'shiba';
  const b = BREEDS[breedKey];
  const p = pose || {};
  const lie = Math.max(clamp(p.lie), clamp(p.sleep));
  const sit = clamp(p.crouch);
  const stretch = clamp(p.stretch);
  const breath = clamp(p.breath, -.04, .04);
  const up = (Number(p.bounce) || 0) + (Number(p.jump) || 0);
  const facing = Number(p.facing) < 0 ? -1 : 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, size, size);
  ctx.scale(size / 512, size / 512);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.translate(256, 464 - up); ctx.scale(facing, 1); ctx.translate(-256, -464);
  withPivot(ctx, 256, 443, (Number(p.bodyTilt) || 0) * .45, 1 + breath, 1 + breath * .7, () => {
    drawBody(ctx, b, p, lie, sit);
    ctx.save();
    ctx.translate(-lie * 38, lie * 86 + sit * 19 + stretch * 26 - (Number(p.headY) || 0));
    withPivot(ctx, 256, 288, (Number(p.headTilt) || 0) - lie * .17, 1 - lie * .12, 1 - lie * .17, () => drawFace(ctx, b, breedKey, p));
    ctx.restore();
  });
  // The accents have independent opacity so action transitions can ease smoothly.
  if (clamp(p.heart) > 0) {
    const h = clamp(p.heart);
    ctx.save(); ctx.globalAlpha *= h;
    heart(ctx, 409, 159 - h * 30, .9, '#DF8C8A');
    heart(ctx, 103, 201 - h * 20, .55, '#EDB1A1');
    heart(ctx, 357, 67 - h * 11, .45, '#D57E82'); ctx.restore();
  }
  if (clamp(p.sparkle) > 0) {
    const s = clamp(p.sparkle);
    ctx.save(); ctx.globalAlpha *= s;
    star(ctx, 98, 179, 12 + s * 4, '#DFB765'); star(ctx, 420, 255, 9 + s * 2, '#DFB765');
    star(ctx, 383, 113, 7, '#EBCD86');
    oval(ctx, 101, 158, 3, 3, '#EACB89'); oval(ctx, 419, 276, 2.5, 2.5, '#EACB89'); ctx.restore();
  }
  if (clamp(p.sleep) > .15) {
    ctx.save(); ctx.globalAlpha *= clamp((p.sleep - .15) * 2);
    ctx.strokeStyle = '#869B9D'; ctx.lineWidth = 3.6;
    stroke(ctx, 'M351 218 L365 218 L351 233 L365 233', '#869B9D', 3.5);
    stroke(ctx, 'M376 187 L395 187 L376 207 L395 207', '#869B9D', 4);
    stroke(ctx, 'M407 153 L430 153 L407 177 L430 177', '#869B9D', 4.2);
    ctx.restore();
  }
  ctx.restore();
}

export const DOG_2D_BREEDS = Object.freeze(Object.keys(BREEDS));
