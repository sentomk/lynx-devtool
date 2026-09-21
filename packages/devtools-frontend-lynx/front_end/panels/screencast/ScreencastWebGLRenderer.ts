// Copyright 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

// The shaders below are a readable WebGL2 port of AMD FidelityFX FSR 1
// EASU/RCAS. FidelityFX FSR 1 is distributed under the MIT license.
// Source: https://github.com/GPUOpen-Effects/FidelityFX-FSR
/*
Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const EASU_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_source;
uniform vec2 u_inputSize;
uniform vec2 u_outputSize;
out vec4 outColor;

ivec2 clampPixel(ivec2 p) {
  return clamp(p, ivec2(0), ivec2(u_inputSize) - ivec2(1));
}

vec3 loadPixel(ivec2 p) {
  ivec2 pixel = clampPixel(p);
  pixel.y = int(u_inputSize.y) - 1 - pixel.y;
  return texelFetch(u_source, pixel, 0).rgb;
}

float luma2(vec3 color) {
  return color.b * 0.5 + color.r * 0.5 + color.g;
}

void setDirection(
  inout vec2 direction,
  inout float edgeLength,
  vec2 fractionalPosition,
  int corner,
  float a,
  float b,
  float c,
  float d,
  float e
) {
  float weight = 0.0;
  if (corner == 0) weight = (1.0 - fractionalPosition.x) * (1.0 - fractionalPosition.y);
  if (corner == 1) weight = fractionalPosition.x * (1.0 - fractionalPosition.y);
  if (corner == 2) weight = (1.0 - fractionalPosition.x) * fractionalPosition.y;
  if (corner == 3) weight = fractionalPosition.x * fractionalPosition.y;

  float dc = d - c;
  float cb = c - b;
  float lengthX = max(abs(dc), abs(cb));
  float directionX = d - b;
  direction.x += directionX * weight;
  lengthX = clamp(abs(directionX) / max(lengthX, 1e-6), 0.0, 1.0);
  edgeLength += lengthX * lengthX * weight;

  float ec = e - c;
  float ca = c - a;
  float lengthY = max(abs(ec), abs(ca));
  float directionY = e - a;
  direction.y += directionY * weight;
  lengthY = clamp(abs(directionY) / max(lengthY, 1e-6), 0.0, 1.0);
  edgeLength += lengthY * lengthY * weight;
}

void addTap(
  inout vec3 accumulatedColor,
  inout float accumulatedWeight,
  vec2 offset,
  vec2 direction,
  vec2 anisotropicLength,
  float negativeLobe,
  float clippingPoint,
  vec3 color
) {
  vec2 rotated;
  rotated.x = offset.x * direction.x + offset.y * direction.y;
  rotated.y = offset.x * -direction.y + offset.y * direction.x;
  rotated *= anisotropicLength;
  float distanceSquared = min(dot(rotated, rotated), clippingPoint);

  float windowWeight = (2.0 / 5.0) * distanceSquared - 1.0;
  float lobeWeight = negativeLobe * distanceSquared - 1.0;
  windowWeight *= windowWeight;
  lobeWeight *= lobeWeight;
  windowWeight = (25.0 / 16.0) * windowWeight - (25.0 / 16.0 - 1.0);
  float weight = windowWeight * lobeWeight;
  accumulatedColor += color * weight;
  accumulatedWeight += weight;
}

void main() {
  ivec2 outputPixel = ivec2(gl_FragCoord.xy);
  vec2 scale = u_inputSize / u_outputSize;
  vec2 sourcePosition = vec2(outputPixel) * scale + 0.5 * scale - 0.5;
  ivec2 base = ivec2(floor(sourcePosition));
  vec2 fractionalPosition = fract(sourcePosition);

  vec3 b = loadPixel(base + ivec2( 0, -1));
  vec3 c = loadPixel(base + ivec2( 1, -1));
  vec3 e = loadPixel(base + ivec2(-1,  0));
  vec3 f = loadPixel(base + ivec2( 0,  0));
  vec3 g = loadPixel(base + ivec2( 1,  0));
  vec3 h = loadPixel(base + ivec2( 2,  0));
  vec3 i = loadPixel(base + ivec2(-1,  1));
  vec3 j = loadPixel(base + ivec2( 0,  1));
  vec3 k = loadPixel(base + ivec2( 1,  1));
  vec3 l = loadPixel(base + ivec2( 2,  1));
  vec3 n = loadPixel(base + ivec2( 0,  2));
  vec3 o = loadPixel(base + ivec2( 1,  2));

  float bL = luma2(b);
  float cL = luma2(c);
  float eL = luma2(e);
  float fL = luma2(f);
  float gL = luma2(g);
  float hL = luma2(h);
  float iL = luma2(i);
  float jL = luma2(j);
  float kL = luma2(k);
  float lL = luma2(l);
  float nL = luma2(n);
  float oL = luma2(o);

  vec2 direction = vec2(0.0);
  float edgeLength = 0.0;
  setDirection(direction, edgeLength, fractionalPosition, 0, bL, eL, fL, gL, jL);
  setDirection(direction, edgeLength, fractionalPosition, 1, cL, fL, gL, hL, kL);
  setDirection(direction, edgeLength, fractionalPosition, 2, fL, iL, jL, kL, nL);
  setDirection(direction, edgeLength, fractionalPosition, 3, gL, jL, kL, lL, oL);

  float directionLengthSquared = dot(direction, direction);
  if (directionLengthSquared < (1.0 / 32768.0)) {
    direction = vec2(1.0, 0.0);
  } else {
    direction *= inversesqrt(directionLengthSquared);
  }

  edgeLength = edgeLength * 0.5;
  edgeLength *= edgeLength;
  float stretch = 1.0 / max(abs(direction.x), abs(direction.y));
  vec2 anisotropicLength = vec2(
    mix(1.0, stretch, edgeLength),
    mix(1.0, 0.5, edgeLength)
  );
  float negativeLobe = mix(0.5, (1.0 / 4.0 - 0.04), edgeLength);
  float clippingPoint = 1.0 / negativeLobe;

  vec3 minimum4 = min(min(f, g), min(j, k));
  vec3 maximum4 = max(max(f, g), max(j, k));
  vec3 accumulatedColor = vec3(0.0);
  float accumulatedWeight = 0.0;

  addTap(accumulatedColor, accumulatedWeight, vec2( 0.0, -1.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, b);
  addTap(accumulatedColor, accumulatedWeight, vec2( 1.0, -1.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, c);
  addTap(accumulatedColor, accumulatedWeight, vec2(-1.0,  1.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, i);
  addTap(accumulatedColor, accumulatedWeight, vec2( 0.0,  1.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, j);
  addTap(accumulatedColor, accumulatedWeight, vec2( 0.0,  0.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, f);
  addTap(accumulatedColor, accumulatedWeight, vec2(-1.0,  0.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, e);
  addTap(accumulatedColor, accumulatedWeight, vec2( 1.0,  1.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, k);
  addTap(accumulatedColor, accumulatedWeight, vec2( 2.0,  1.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, l);
  addTap(accumulatedColor, accumulatedWeight, vec2( 2.0,  0.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, h);
  addTap(accumulatedColor, accumulatedWeight, vec2( 1.0,  0.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, g);
  addTap(accumulatedColor, accumulatedWeight, vec2( 1.0,  2.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, o);
  addTap(accumulatedColor, accumulatedWeight, vec2( 0.0,  2.0) - fractionalPosition, direction, anisotropicLength, negativeLobe, clippingPoint, n);

  vec3 result = accumulatedColor / max(accumulatedWeight, 1e-6);
  outColor = vec4(clamp(result, minimum4, maximum4), 1.0);
}`;

const RCAS_SHADER = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_source;
uniform ivec2 u_size;
uniform float u_sharpness;
out vec4 outColor;

ivec2 clampPixel(ivec2 p) {
  return clamp(p, ivec2(0), u_size - ivec2(1));
}

vec3 loadPixel(ivec2 p) {
  return texelFetch(u_source, clampPixel(p), 0).rgb;
}

vec3 safeReciprocal(vec3 value) {
  return sign(value) / max(abs(value), vec3(1e-6));
}

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec3 b = loadPixel(pixel + ivec2( 0, -1));
  vec3 d = loadPixel(pixel + ivec2(-1,  0));
  vec3 e = loadPixel(pixel);
  vec3 f = loadPixel(pixel + ivec2( 1,  0));
  vec3 h = loadPixel(pixel + ivec2( 0,  1));

  vec3 minimum4 = min(min(b, d), min(f, h));
  vec3 maximum4 = max(max(b, d), max(f, h));
  vec3 hitMinimum = min(minimum4, e) / max(4.0 * maximum4, vec3(1e-6));
  vec3 hitMaximum = (vec3(1.0) - max(maximum4, e)) * safeReciprocal(4.0 * minimum4 - vec3(4.0));
  vec3 lobeRGB = max(-hitMinimum, hitMaximum);
  float lobe = clamp(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), -0.1875, 0.0);
  lobe *= u_sharpness;

  vec3 result = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`;

function required<T>(value: T|null, label: string): T {
  if (!value) {
    throw new Error(`Unable to create ${label}.`);
  }
  return value;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = required(gl.createShader(type), 'WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'unknown shader compilation error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = required(gl.createProgram(), 'WebGL program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, 'a_position');
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function configureTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

export class ScreencastWebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly vertexArray: WebGLVertexArrayObject;
  readonly vertexBuffer: WebGLBuffer;
  readonly inputTexture: WebGLTexture;
  readonly easuTexture: WebGLTexture;
  readonly easuFramebuffer: WebGLFramebuffer;
  readonly easuProgram: WebGLProgram;
  readonly rcasProgram: WebGLProgram;
  readonly easuSourceLocation: WebGLUniformLocation;
  readonly easuInputSizeLocation: WebGLUniformLocation;
  readonly easuOutputSizeLocation: WebGLUniformLocation;
  readonly rcasSourceLocation: WebGLUniformLocation;
  readonly rcasSizeLocation: WebGLUniformLocation;
  readonly rcasSharpnessLocation: WebGLUniformLocation;
  inputWidth = 0;
  inputHeight = 0;
  outputWidth = 0;
  outputHeight = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 is unavailable in this DevTool runtime.');
    }
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.vertexArray = required(gl.createVertexArray(), 'vertex array');
    this.vertexBuffer = required(gl.createBuffer(), 'vertex buffer');
    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.inputTexture = required(gl.createTexture(), 'input texture');
    configureTexture(gl, this.inputTexture);
    this.easuTexture = required(gl.createTexture(), 'EASU texture');
    configureTexture(gl, this.easuTexture);
    this.easuFramebuffer = required(gl.createFramebuffer(), 'EASU framebuffer');
    this.easuProgram = createProgram(gl, EASU_SHADER);
    this.rcasProgram = createProgram(gl, RCAS_SHADER);
    this.easuSourceLocation =
        required(gl.getUniformLocation(this.easuProgram, 'u_source'), 'EASU source uniform');
    this.easuInputSizeLocation =
        required(gl.getUniformLocation(this.easuProgram, 'u_inputSize'), 'EASU input-size uniform');
    this.easuOutputSizeLocation =
        required(gl.getUniformLocation(this.easuProgram, 'u_outputSize'), 'EASU output-size uniform');
    this.rcasSourceLocation =
        required(gl.getUniformLocation(this.rcasProgram, 'u_source'), 'RCAS source uniform');
    this.rcasSizeLocation =
        required(gl.getUniformLocation(this.rcasProgram, 'u_size'), 'RCAS size uniform');
    this.rcasSharpnessLocation =
        required(gl.getUniformLocation(this.rcasProgram, 'u_sharpness'), 'RCAS sharpness uniform');
  }

  render(
      source: HTMLCanvasElement, outputWidth: number, outputHeight: number,
      sharpness: number): void {
    const gl = this.gl;
    const width = Math.max(1, Math.floor(outputWidth));
    const height = Math.max(1, Math.floor(outputHeight));
    if (Math.max(source.width, source.height, width, height) > this.maxTextureSize) {
      throw new Error(`Screencast exceeds the WebGL texture limit (${this.maxTextureSize}px).`);
    }
    const beginMark = 'ScreenCast.WebGLReconstruct.Begin';
    const endMark = 'ScreenCast.WebGLReconstruct.End';
    const measureName = 'ScreenCast.WebGLReconstruct.Submit';
    performance.clearMarks(beginMark);
    performance.clearMarks(endMark);
    performance.clearMeasures(measureName);
    performance.mark(beginMark);
    this.resizeOutput(width, height);
    gl.bindVertexArray(this.vertexArray);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (source.width === this.inputWidth && source.height === this.inputHeight) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.inputWidth = source.width;
      this.inputHeight = source.height;
    }

    gl.useProgram(this.easuProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.easuFramebuffer);
    gl.viewport(0, 0, width, height);
    gl.uniform1i(this.easuSourceLocation, 0);
    gl.uniform2f(this.easuInputSizeLocation, source.width, source.height);
    gl.uniform2f(this.easuOutputSizeLocation, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.rcasProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, this.easuTexture);
    gl.uniform1i(this.rcasSourceLocation, 0);
    gl.uniform2i(this.rcasSizeLocation, width, height);
    gl.uniform1f(this.rcasSharpnessLocation, Math.max(0, Math.min(1, sharpness)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
    performance.mark(endMark);
    performance.measure(measureName, beginMark, endMark);
    performance.clearMarks(beginMark);
    performance.clearMarks(endMark);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.easuProgram);
    gl.deleteProgram(this.rcasProgram);
    gl.deleteFramebuffer(this.easuFramebuffer);
    gl.deleteTexture(this.inputTexture);
    gl.deleteTexture(this.easuTexture);
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteVertexArray(this.vertexArray);
  }

  private resizeOutput(width: number, height: number): void {
    if (width === this.outputWidth && height === this.outputHeight) {
      return;
    }
    const gl = this.gl;
    this.outputWidth = width;
    this.outputHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
    gl.bindTexture(gl.TEXTURE_2D, this.easuTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.easuFramebuffer);
    gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.easuTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('The screencast WebGL framebuffer is incomplete.');
    }
  }
}
