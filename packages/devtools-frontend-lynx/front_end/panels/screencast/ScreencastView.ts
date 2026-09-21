/*
 * Copyright (C) 2013 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Google Inc. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/* eslint-disable rulesdir/no_underscored_properties */

import * as Common from '../../core/common/common.js';
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';
import * as UI from '../../ui/legacy/legacy.js';
import { postPluginMessage } from '../../core/protocol_client/InspectorBackend.js';

interface EncodedVideoChunkInit {
  type: 'key'|'delta';
  timestamp: number;
  data: Uint8Array;
}
declare const EncodedVideoChunk: new (init: EncodedVideoChunkInit) => unknown;
interface VideoFrameLike {
  displayWidth: number;
  displayHeight: number;
  close(): void;
}
interface VideoDecoderLike {
  readonly state: string;
  configure(config: {codec: string, optimizeForLatency?: boolean}): void;
  decode(chunk: unknown): void;
  close(): void;
}
declare const VideoDecoder: new (init: {
  output: (frame: VideoFrameLike) => void;
  error: (error: Error) => void;
}) => VideoDecoderLike;

const WEBGL_RECONSTRUCTION_SD_CAPTURE_SCALE = 0.6;
const WEBGL_RECONSTRUCTION_SD_JPEG_QUALITY = 40;
const WEBGL_RECONSTRUCTION_HD_CAPTURE_SCALE = 0.8;
const WEBGL_RECONSTRUCTION_HD_JPEG_QUALITY = 70;
const WEBGL_RECONSTRUCTION_SHARPNESS = 0.25;

function lynxFrameMetadata(
    metadata: Protocol.Page.ScreencastFrameMetadata): Protocol.Page.LynxScreencastFrameMetadata|undefined {
  return metadata.lynxFrame;
}

import { InputModel } from './InputModel.js';
import {ScreencastWebGLRenderer} from './ScreencastWebGLRenderer.js';

const UIStrings = {
  /**
  *@description Accessible alt text for the screencast canvas rendering of the debug target webpage
  */
  screencastViewOfDebugTarget: 'Screencast view of debug target',
  /**
  *@description Glass pane element text content in Screencast View of the Remote Devices tab when toggling screencast
  */
  theTabIsInactive: 'The tab is inactive',
  /**
  *@description Glass pane element text content in Screencast View of the Remote Devices tab when toggling screencast
  */
  profilingInProgress: 'Profiling in progress',
  /**
  *@description Accessible text for the screencast back button
  */
  back: 'back',
  /**
  *@description Accessible text for the screencast forward button
  */
  forward: 'forward',
  /**
  *@description Accessible text for the screencast reload button
  */
  reload: 'reload',
  /**
  *@description Accessible text for the address bar in screencast view
  */
  addressBar: 'Address bar',
  /**
  *@description Accessible text for choosing the Lynx screencast pipeline
  */
  betterScreencast: 'Screencast pipeline: old or new',
  /**
  *@description Accessible text for enabling low-resolution capture with WebGL reconstruction
  */
  webGLReconstruction: 'FSR 1 reconstruction: SD uses 0.6 resolution and Q40; HD uses 0.8 resolution and Q70',
};
const str_ = i18n.i18n.registerUIStrings('panels/screencast/ScreencastView.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);

interface Point {
  x: number;
  y: number;
}

export class ScreencastView extends UI.Widget.VBox implements SDK.OverlayModel.Highlighter {
  _screenCaptureModel: SDK.ScreenCaptureModel.ScreenCaptureModel;
  _domModel: SDK.DOMModel.DOMModel | null;
  _overlayModel: SDK.OverlayModel.OverlayModel | null;
  _resourceTreeModel: SDK.ResourceTreeModel.ResourceTreeModel | null;
  _networkManager: SDK.NetworkManager.NetworkManager | null;
  _inputModel: InputModel | null;
  _shortcuts: { [x: number]: (arg0?: Event | undefined) => boolean };
  _scrollOffsetX: number;
  _scrollOffsetY: number;
  _screenZoom: number;
  _screenOffsetTop: number;
  _pageScaleFactor: number;
  _imageElement!: HTMLImageElement;
  _viewportElement!: HTMLElement;
  _glassPaneElement!: HTMLElement;
  _canvasElement!: HTMLCanvasElement;
  _titleElement!: HTMLElement;
  _context!: CanvasRenderingContext2D;
  _imageZoom: number;
  _tagNameElement!: HTMLElement;
  _attributeElement!: HTMLElement;
  _nodeWidthElement!: HTMLElement;
  _nodeHeightElement!: HTMLElement;
  _model!: Protocol.DOM.BoxModel | null;
  _highlightConfig!: Protocol.Overlay.HighlightConfig | null;
  _navigationUrl!: HTMLInputElement;
  _navigationBack!: HTMLButtonElement;
  _navigationForward!: HTMLButtonElement;
  _canvasContainerElement?: HTMLElement;
  _isCasting?: boolean;
  _checkerboardPattern?: CanvasPattern | null;
  _targetInactive?: boolean;
  _deferredCasting?: number;
  _highlightNode?: SDK.DOMModel.DOMNode | null;
  _config?: Protocol.Overlay.HighlightConfig | null;
  _node?: SDK.DOMModel.DOMNode | null;
  _inspectModeConfig?: Protocol.Overlay.HighlightConfig | null;
  _navigationBar?: HTMLElement;
  _navigationReload?: HTMLElement;
  _navigationProgressBar?: ProgressTracker;
  _historyIndex?: number;
  _historyEntries?: Protocol.Page.NavigationEntry[];
  _navigationScreenSwitch?: HTMLInputElement;
  _navigationScreenCastModeSwitch?: HTMLInputElement;
  _navigationBetterScreencastSwitch?: HTMLInputElement;
  _navigationWebGLReconstructionSwitch?: HTMLInputElement;
  _navigationFrameSignalGateSwitch?: HTMLInputElement;
  _frameLayoutKey?: string;
  _frameCanvas!: HTMLCanvasElement;
  _frameContext!: CanvasRenderingContext2D;
  _composedFrameId?: number;
  _highlightRefreshPending?: boolean;
  _h264Decoder?: VideoDecoderLike;
  _h264CodecString?: string;
  _h264Casting?: boolean;
  _h264PendingFrames: Protocol.Page.ScreencastFrameMetadata[] = [];
  _h264FrameVisible?: boolean;
  _webGLRenderer?: ScreencastWebGLRenderer;
  _webGLFrameVisible: boolean;
  _webGLUnavailableLogged: boolean;
  _requestedPresentationWidth: number;
  _requestedPresentationHeight: number;
  constructor(screenCaptureModel: SDK.ScreenCaptureModel.ScreenCaptureModel) {
    super();
    this._screenCaptureModel = screenCaptureModel;
    this._domModel = screenCaptureModel.target().model(SDK.DOMModel.DOMModel);
    this._overlayModel = screenCaptureModel.target().model(SDK.OverlayModel.OverlayModel);
    this._resourceTreeModel = screenCaptureModel.target().model(SDK.ResourceTreeModel.ResourceTreeModel);
    this._networkManager = screenCaptureModel.target().model(SDK.NetworkManager.NetworkManager);
    this._inputModel = screenCaptureModel.target().model(InputModel);

    this.setMinimumSize(150, 150);
    this.registerRequiredCSS('panels/screencast/screencastView.css');
    this._shortcuts = {} as {
      [x: number]: (arg0?: Event | undefined) => boolean,
    };
    this._scrollOffsetX = 0;
    this._scrollOffsetY = 0;
    this._screenZoom = 1;
    this._screenOffsetTop = 0;
    this._pageScaleFactor = 1;
    this._imageZoom = 1;
    this._webGLFrameVisible = false;
    this._webGLUnavailableLogged = false;
    this._requestedPresentationWidth = 1;
    this._requestedPresentationHeight = 1;
  }

  initialize(): void {
    this.element.classList.add('screencast');
    this._createNavigationBar();
    this._viewportElement = this.element.createChild('div', 'screencast-viewport hidden') as HTMLElement;
    this._canvasContainerElement =
      this._viewportElement.createChild('div', 'screencast-canvas-container') as HTMLElement;
    this._glassPaneElement =
      this._canvasContainerElement.createChild('div', 'screencast-glasspane fill hidden') as HTMLElement;
    this._canvasElement = this._canvasContainerElement.createChild('canvas') as HTMLCanvasElement;
    UI.ARIAUtils.setAccessibleName(this._canvasElement, i18nString(UIStrings.screencastViewOfDebugTarget));
    this._canvasElement.tabIndex = 0;
    this._canvasElement.addEventListener('mousedown', this._handleMouseEvent.bind(this), false);
    this._canvasElement.addEventListener('mouseup', this._handleMouseEvent.bind(this), false);
    this._canvasElement.addEventListener('mousemove', this._handleMouseEvent.bind(this), false);
    this._canvasElement.addEventListener('mousewheel', this._handleMouseEvent.bind(this), false);
    this._canvasElement.addEventListener('click', this._handleMouseEvent.bind(this), false);
    this._canvasElement.addEventListener('contextmenu', this._handleContextMenuEvent.bind(this), false);
    this._canvasElement.addEventListener('keydown', this._handleKeyEvent.bind(this), false);
    this._canvasElement.addEventListener('keyup', this._handleKeyEvent.bind(this), false);
    this._canvasElement.addEventListener('keypress', this._handleKeyEvent.bind(this), false);
    this._canvasElement.addEventListener('blur', this._handleBlurEvent.bind(this), false);
    this._titleElement =
      this._canvasContainerElement.createChild('div', 'screencast-element-title monospace hidden') as HTMLElement;
    this._tagNameElement = this._titleElement.createChild('span', 'screencast-tag-name') as HTMLElement;
    this._attributeElement = this._titleElement.createChild('span', 'screencast-attribute') as HTMLElement;
    UI.UIUtils.createTextChild(this._titleElement, ' ');
    const dimension = this._titleElement.createChild('span', 'screencast-dimension') as HTMLElement;
    this._nodeWidthElement = dimension.createChild('span') as HTMLElement;
    UI.UIUtils.createTextChild(dimension, ' × ');
    this._nodeHeightElement = dimension.createChild('span') as HTMLElement;
    this._titleElement.style.top = '0';
    this._titleElement.style.left = '0';

    this._imageElement = new Image();
    this._frameCanvas = document.createElement('canvas');
    this._frameCanvas.width = 1;
    this._frameCanvas.height = 1;
    this._frameContext = this._frameCanvas.getContext('2d') as CanvasRenderingContext2D;
    this._isCasting = false;
    this._context = this._canvasElement.getContext('2d') as CanvasRenderingContext2D;
    this._checkerboardPattern = this._createCheckerboardPattern(this._context);

    this._shortcuts[UI.KeyboardShortcut.KeyboardShortcut.makeKey('l', UI.KeyboardShortcut.Modifiers.Ctrl)] =
      this._focusNavigationBar.bind(this);

    SDK.TargetManager.TargetManager.instance().addEventListener(
      SDK.TargetManager.Events.SuspendStateChanged, this._onSuspendStateChange, this);
    this._updateGlasspane();
  }

  wasShown(): void {
    this._startCasting();
  }

  willHide(): void {
    this._stopCasting();
  }

  _startCasting(): void {
    console.info('[ScreencastLifecycle] frontend start requested', {
      targetId: this._screenCaptureModel.target().id(),
      url: this._screenCaptureModel.target().inspectedURL(),
      isCasting: this._isCasting,
    });
    if (SDK.TargetManager.TargetManager.instance().allTargetsSuspended()) {
      return;
    }
    if (this._isCasting) {
      return;
    }
    if (!Common.Settings.Settings.instance().settingForTest<boolean>('screencastEnabled').get()) {
      return;
    }

    const dimensions = this._viewportDimensions();
    if (dimensions.width < 0 || dimensions.height < 0) {
      return;
    }

    this._isCasting = true;
    this._frameLayoutKey = undefined;
    this._composedFrameId = undefined;
    const maxImageDimension = 2048;
    const enableBetterScreencast =
        Common.Settings.Settings.instance().createSetting<boolean>('enableBetterScreencast', true).get();
    const hdSetting = localStorage.getItem('isHD');
    const isHD = hdSetting !== null && hdSetting !== 'false';
    dimensions.width *= window.devicePixelRatio;
    dimensions.height *= window.devicePixelRatio;
    const useWebGLReconstruction = enableBetterScreencast && this._webGLReconstructionRequested();
    this._requestedPresentationWidth = Math.floor(Math.min(maxImageDimension, dimensions.width));
    this._requestedPresentationHeight = Math.floor(dimensions.height);
    const captureScale = useWebGLReconstruction
        ? (isHD ? WEBGL_RECONSTRUCTION_HD_CAPTURE_SCALE : WEBGL_RECONSTRUCTION_SD_CAPTURE_SCALE)
        : 1;
    const qualityValue = useWebGLReconstruction
        ? (isHD ? WEBGL_RECONSTRUCTION_HD_JPEG_QUALITY : WEBGL_RECONSTRUCTION_SD_JPEG_QUALITY)
        : (isHD ? 100 : 20);
    // Note: startScreencast width and height are expected to be integers so must be floored.
    this._h264Casting = false;
    this._webGLFrameVisible = false;
    const format = Protocol.Page.StartScreencastRequestFormat.Jpeg;
    const maxWidth = Math.max(1, Math.floor(this._requestedPresentationWidth * captureScale));
    const maxHeight = Math.max(1, Math.floor(this._requestedPresentationHeight * captureScale));
    this._screenCaptureModel.startScreencast(
      format,
      qualityValue,
      maxWidth,
      maxHeight,
      undefined,
      this._screencastFrame.bind(this),
      this._screencastVisibilityChanged.bind(this),
      undefined,
      false,
      enableBetterScreencast,
      enableBetterScreencast && Common.Settings.Settings.instance()
          .createSetting<boolean>('enableFrameSignalGate', false).get(),
    );
    for (const emulationModel of SDK.TargetManager.TargetManager.instance().models(SDK.EmulationModel.EmulationModel)) {
      emulationModel.overrideEmulateTouch(true);
    }
    if (this._overlayModel) {
      this._overlayModel.setHighlighter(this);
    }
  }

  _stopCasting(): void {
    console.info('[ScreencastLifecycle] frontend stop requested', {
      targetId: this._screenCaptureModel.target().id(),
      url: this._screenCaptureModel.target().inspectedURL(),
      isCasting: this._isCasting,
    });
    if (!this._isCasting) {
      return;
    }
    this._isCasting = false;
    this._webGLFrameVisible = false;
    this._destroyH264Decoder();
    this._screenCaptureModel.stopScreencast();
    for (const emulationModel of SDK.TargetManager.TargetManager.instance().models(SDK.EmulationModel.EmulationModel)) {
      emulationModel.overrideEmulateTouch(false);
    }
    if (this._overlayModel) {
      this._overlayModel.setHighlighter(null);
    }
  }

  _screencastFrame(base64Data: string, metadata: Protocol.Page.ScreencastFrameMetadata): void|Promise<void> {
    if (metadata.format === 'h264' || metadata.codec === 'h264') {
      this._handleH264Frame(base64Data, metadata);
      return;
    }
    this._destroyH264Decoder();
    return new Promise(resolve => {
      // A cached full frame and the first live frame can arrive back-to-back
      // when a card is resumed. Keep their decoder state independent; sharing
      // one Image would let the later payload overwrite the earlier onload/src
      // pair and associate image bytes with the wrong delta metadata.
      const image = new Image();
      const complete = (): void => {
        image.onload = null;
        image.onerror = null;
        resolve();
      };
      image.onload = async (): Promise<void> => {
        try {
          const frame = lynxFrameMetadata(metadata);
          const fullWidth = frame?.fullWidth ?? image.naturalWidth;
          const fullHeight = frame?.fullHeight ?? image.naturalHeight;
          if (frame?.frameType === 'delta') {
            const baseMatches = frame.baseFrameId !== undefined && frame.baseFrameId === this._composedFrameId;
            const dimensionsMatch =
                this._frameCanvas.width === fullWidth && this._frameCanvas.height === fullHeight;
            if (!baseMatches || !dimensionsMatch) {
              console.warn('[Screencast] Ignoring delta frame with a missing base frame.', {
                frameId: frame.frameId,
                baseFrameId: frame.baseFrameId,
                composedFrameId: this._composedFrameId,
              });
              return;
            }
            const deltaX = frame.x;
            const deltaY = frame.y;
            const deltaWidth = frame.width;
            const deltaHeight = frame.height;
            this._frameContext.drawImage(
                image, 0, 0, image.naturalWidth, image.naturalHeight,
                deltaX, deltaY, deltaWidth, deltaHeight);
          } else {
            if (this._frameCanvas.width !== fullWidth || this._frameCanvas.height !== fullHeight) {
              this._frameCanvas.width = fullWidth;
              this._frameCanvas.height = fullHeight;
            } else {
              this._frameContext.clearRect(0, 0, fullWidth, fullHeight);
            }
            this._frameContext.drawImage(image, 0, 0, fullWidth, fullHeight);
          }
          this._imageElement = image;
          this._composedFrameId = frame?.frameId;
          this._updateWebGLFrame();

          this._pageScaleFactor = metadata.pageScaleFactor;
          this._screenOffsetTop = metadata.offsetTop;
          this._scrollOffsetX = metadata.scrollOffsetX;
          this._scrollOffsetY = metadata.scrollOffsetY;

          const presentationFrame = this._presentedFrameCanvas();
          const presentationWidth = presentationFrame.width;
          const presentationHeight = presentationFrame.height;
          const frameLayoutKey = [
            'jpeg',
            presentationWidth,
            presentationHeight,
            metadata.deviceWidth,
            metadata.deviceHeight,
            window.devicePixelRatio,
            this._webGLFrameVisible,
          ].join(':');
          if (frameLayoutKey !== this._frameLayoutKey) {
            this._frameLayoutKey = frameLayoutKey;
            const dimensionsCSS = this._viewportDimensions();
            this._imageZoom = dimensionsCSS.width / presentationWidth;
            this._viewportElement.classList.remove('hidden');
            const bordersSize = BORDERS_SIZE;
            if (this._imageZoom < 1.01 / window.devicePixelRatio) {
              this._imageZoom = 1 / window.devicePixelRatio;
            }
            this._screenZoom = presentationWidth / metadata.deviceWidth;
            this._viewportElement.style.width =
                metadata.deviceWidth * this._screenZoom * this._imageZoom + bordersSize + 'px';
            this._viewportElement.style.height =
                metadata.deviceHeight * this._screenZoom * this._imageZoom + bordersSize + 'px';
          }

          // Present the frame before doing any DOM/highlight RPC. A selected
          // element's boxModel request may be slow or never resolve when the
          // page is transitioning; tying the frame ACK to that request stalls
          // the complete screencast pipeline.
          this._repaint();
          this._refreshHighlightForCurrentFrame();
        } catch (error) {
          console.error('Failed to render screencast frame:', error);
        } finally {
          complete();
        }
      };
      image.onerror = complete;
      const mimeType = metadata.format === 'png' ? 'image/png' : 'image/jpeg';
      image.src = `data:${mimeType};base64,${base64Data}`;
    });
  }

  _base64ToBytes(base64Data: string): Uint8Array {
    return ScreencastView.base64ToBytes(base64Data);
  }

  static base64ToBytes(base64Data: string): Uint8Array {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; ++index) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  _webGLReconstructionRequested(): boolean {
    const settings = Common.Settings.Settings.instance();
    return settings.createSetting<boolean>('enableBetterScreencast', true).get() &&
        settings.createSetting<boolean>('enableScreencastWebGLReconstruction', false).get();
  }

  _updateWebGLFrame(): void {
    this._webGLFrameVisible = false;
    if (!this._webGLReconstructionRequested() || this._frameCanvas.width <= 1 || this._frameCanvas.height <= 1) {
      return;
    }
    try {
      this._webGLRenderer ??= new ScreencastWebGLRenderer();
      const scale = Math.max(1, Math.min(
          this._requestedPresentationWidth / this._frameCanvas.width,
          this._requestedPresentationHeight / this._frameCanvas.height));
      const outputWidth = Math.max(this._frameCanvas.width, Math.round(this._frameCanvas.width * scale));
      const outputHeight = Math.max(this._frameCanvas.height, Math.round(this._frameCanvas.height * scale));
      this._webGLRenderer.render(
          this._frameCanvas, outputWidth, outputHeight, WEBGL_RECONSTRUCTION_SHARPNESS);
      this._webGLFrameVisible = true;
      this._webGLUnavailableLogged = false;
    } catch (error) {
      if (!this._webGLUnavailableLogged) {
        console.warn('[Screencast] WebGL reconstruction unavailable; showing the captured frame.', error);
        this._webGLUnavailableLogged = true;
      }
    }
  }

  _presentedFrameCanvas(): HTMLCanvasElement {
    if (this._webGLFrameVisible && this._webGLRenderer) {
      return this._webGLRenderer.canvas;
    }
    return this._frameCanvas;
  }

  _ensureH264Decoder(codecString: string): boolean {
    if (this._h264Decoder && this._h264CodecString === codecString) {
      return true;
    }
    this._destroyH264Decoder();
    if (typeof VideoDecoder === 'undefined') {
      return false;
    }
    try {
      this._h264Decoder = new VideoDecoder({
        output: frame => this._drawH264Frame(frame),
        error: error => {
          console.error('[Screencast] H.264 decode error:', error);
          this._destroyH264Decoder();
        },
      });
      this._h264Decoder.configure({codec: codecString, optimizeForLatency: true});
      this._h264CodecString = codecString;
      return true;
    } catch (error) {
      console.error('[Screencast] Unable to configure H.264 decoder:', error);
      this._destroyH264Decoder();
      return false;
    }
  }

  _destroyH264Decoder(): void {
    this._h264PendingFrames = [];
    this._h264FrameVisible = false;
    if (this._h264Decoder) {
      try {
        this._h264Decoder.close();
      } catch {
        // Decoder teardown is best effort when a target is navigating away.
      }
    }
    this._h264Decoder = undefined;
    this._h264CodecString = undefined;
  }

  _handleH264Frame(base64Data: string, metadata: Protocol.Page.ScreencastFrameMetadata): void {
    const codecString = metadata.codecString;
    if (!codecString || (!this._h264Decoder && !metadata.keyFrame) ||
        !this._ensureH264Decoder(codecString) || !this._h264Decoder ||
        this._h264Decoder.state !== 'configured') {
      return;
    }
    this._h264PendingFrames.push(metadata);
    try {
      this._h264Decoder.decode(new EncodedVideoChunk({
        type: metadata.keyFrame ? 'key' : 'delta',
        timestamp: Math.round((metadata.timestamp || 0) * 1_000_000),
        data: this._base64ToBytes(base64Data),
      }));
    } catch (error) {
      console.error('[Screencast] Unable to submit H.264 frame:', error);
      this._h264PendingFrames.pop();
    }
  }

  _drawH264Frame(frame: VideoFrameLike): void {
    const metadata = this._h264PendingFrames.shift();
    if (!metadata) {
      frame.close();
      return;
    }
    this._presentH264Frame(frame, metadata);
  }

  _presentH264Frame(
      frame: VideoFrameLike, metadata: Protocol.Page.ScreencastFrameMetadata): void {
    try {
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      if (width <= 0 || height <= 0) {
        return;
      }
      if (this._frameCanvas.width !== width || this._frameCanvas.height !== height) {
        this._frameCanvas.width = width;
        this._frameCanvas.height = height;
      }
      this._pageScaleFactor = metadata.pageScaleFactor;
      this._screenOffsetTop = metadata.offsetTop;
      this._scrollOffsetX = metadata.scrollOffsetX;
      this._scrollOffsetY = metadata.scrollOffsetY;
      const frameLayoutKey = [width, height, metadata.deviceWidth, metadata.deviceHeight,
                              window.devicePixelRatio].join(':');
      if (frameLayoutKey !== this._frameLayoutKey) {
        this._frameLayoutKey = frameLayoutKey;
        const dimensionsCSS = this._viewportDimensions();
        this._imageZoom = dimensionsCSS.width / width;
        this._viewportElement.classList.remove('hidden');
        if (this._imageZoom < 1.01 / window.devicePixelRatio) {
          this._imageZoom = 1 / window.devicePixelRatio;
        }
        this._screenZoom = width / metadata.deviceWidth;
        this._viewportElement.style.width =
            metadata.deviceWidth * this._screenZoom * this._imageZoom + BORDERS_SIZE + 'px';
        this._viewportElement.style.height =
            metadata.deviceHeight * this._screenZoom * this._imageZoom + BORDERS_SIZE + 'px';
      }
      if (this._canvasElement.width !== this._canvasWidth ||
          this._canvasElement.height !== this._canvasHeight) {
        this._canvasElement.width = this._canvasWidth;
        this._canvasElement.height = this._canvasHeight;
      }
      // WebCodecs has already produced a GPU-backed VideoFrame. Present it
      // immediately instead of waiting for another animation frame and
      // copying it through the JPEG composition canvas first.
      this._context.globalCompositeOperation = 'source-over';
      this._context.drawImage(frame as unknown as CanvasImageSource, 0, 0, width, height);
      this._h264FrameVisible = true;
    } finally {
      frame.close();
    }
  }

  _isGlassPaneActive(): boolean {
    return !this._glassPaneElement.classList.contains('hidden');
  }

  _screencastVisibilityChanged(visible: boolean): void {
    console.info('[ScreencastLifecycle] frontend visibility', {
      targetId: this._screenCaptureModel.target().id(),
      url: this._screenCaptureModel.target().inspectedURL(),
      visible,
    });
    this._targetInactive = !visible;
    this._updateGlasspane();
    const query = new URLSearchParams(window.location.search);
    window.parent.postMessage({
      type: 'lynx-screencast-visibility-changed',
      clientId: Number(query.get('clientId')),
      sessionId: Number(query.get('sessionId')),
      visible,
    }, window.location.origin);
  }

  _onSuspendStateChange(_event: Common.EventTarget.EventTargetEvent): void {
    if (SDK.TargetManager.TargetManager.instance().allTargetsSuspended()) {
      this._stopCasting();
    } else {
      this._startCasting();
    }
    this._updateGlasspane();
  }

  _updateGlasspane(): void {
    if (this._targetInactive) {
      this._glassPaneElement.textContent = i18nString(UIStrings.theTabIsInactive);
      this._glassPaneElement.classList.remove('hidden');
    } else if (SDK.TargetManager.TargetManager.instance().allTargetsSuspended()) {
      this._glassPaneElement.textContent = i18nString(UIStrings.profilingInProgress);
      this._glassPaneElement.classList.remove('hidden');
    } else {
      this._glassPaneElement.classList.add('hidden');
    }
  }

  async _handleMouseEvent(event: Event): Promise<void> {
    if (this._isGlassPaneActive()) {
      event.consume();
      return;
    }

    if (!this._pageScaleFactor || !this._domModel) {
      return;
    }

    if (!this._inspectModeConfig || event.type === 'mousewheel') {
      // not implemented in lynx
      // if (this._inputModel) {
      //   this._inputModel.emitTouchFromMouseEvent(event, this._screenOffsetTop, this._screenZoom);
      // }
      // allow mousewheel event for viewport vertical scroll
      // event.preventDefault();
      if (event.type === 'mousedown') {
        this._canvasElement.focus();
      }
      return;
    }

    const position = this._convertIntoScreenSpace(event as MouseEvent);

    const node = await this._domModel.nodeForLocation(
      Math.floor(position.x / this._pageScaleFactor + this._scrollOffsetX),
      Math.floor(position.y / this._pageScaleFactor + this._scrollOffsetY),
      Common.Settings.Settings.instance().moduleSetting('showUAShadowDOM').get());

    if (!node) {
      return;
    }

    postPluginMessage('uitree-panel', { UINodeId: node.id });
    postPluginMessage('uitree-drawer', { UINodeId: node.id });
    window.postMessage({
      type: 'panel:preact_devtools',
      content: {
        type: 'ScreenCastPanelUINodeIdSelected',
        message: {
          UINodeId: node.id,
        },
      },
    }, '*');

    if (event.type === 'mousemove') {
      this._updateHighlightInOverlayAndRepaint({ node, selectorList: undefined }, this._inspectModeConfig);
      this._domModel.overlayModel().nodeHighlightRequested({ nodeId: node.id });
    } else if (event.type === 'click') {
      // focus uitree-drawer on drawer panel if uitree-panel was shown on main panel before click
      const inspectorView = UI.InspectorView.InspectorView.instance();
      if (inspectorView._tabbedPane.selectedTabId === 'uitree-panel') {
        inspectorView._tabbedPane.selectTab('elements');
        inspectorView.showPanel('uitree-drawer');
        postPluginMessage('uitree-drawer', { UINodeId: node.id });
        this._overlayModel?.setHighlighter(this);
      }

      this._domModel.overlayModel().inspectNodeRequested({ backendNodeId: node.backendNodeId() });
    }
  }

  _handleKeyEvent(event: Event): void {
    if (this._isGlassPaneActive()) {
      event.consume();
      return;
    }

    const shortcutKey = UI.KeyboardShortcut.KeyboardShortcut.makeKeyFromEvent(event as KeyboardEvent);
    const handler = this._shortcuts[shortcutKey];
    if (handler && handler(event)) {
      event.consume();
      return;
    }

    if (this._inputModel) {
      this._inputModel.emitKeyEvent(event);
    }
    event.consume();
    this._canvasElement.focus();
  }

  _handleContextMenuEvent(event: Event): void {
    event.consume(true);
  }

  _handleBlurEvent(_event: Event): void {
    if (this._inputModel) {
      this._inputModel.cancelTouch();
    }
  }

  _convertIntoScreenSpace(event: MouseEvent): Point {
    return {
      x: Math.round(this._cssToCanvas(event.offsetX) / this._screenZoom),
      y: Math.round(this._cssToCanvas(event.offsetY) / this._screenZoom - this._screenOffsetTop),
    };
  }

  onResize(): void {
    if (this._deferredCasting) {
      clearTimeout(this._deferredCasting);
      delete this._deferredCasting;
    }

    this._stopCasting();
    this._deferredCasting = window.setTimeout(this._startCasting.bind(this), 100);
  }

  highlightInOverlay(data: SDK.OverlayModel.HighlightData, config: Protocol.Overlay.HighlightConfig | null): void {
    this._updateHighlightInOverlayAndRepaint(data, config);
  }

  async _updateHighlightInOverlayAndRepaint(
    data: SDK.OverlayModel.HighlightData, config: Protocol.Overlay.HighlightConfig | null): Promise<void> {
    let node: SDK.DOMModel.DOMNode | null = null;
    if ('node' in data) {
      node = data.node;
    }
    if (!node && 'deferredNode' in data) {
      node = await data.deferredNode.resolvePromise();
    }
    if (!node && 'object' in data) {
      const domModel = data.object.runtimeModel().target().model(SDK.DOMModel.DOMModel);
      if (domModel) {
        node = await domModel.pushObjectAsNodeToFrontend(data.object);
      }
    }

    this._highlightNode = node;
    this._highlightConfig = config;
    if (!node) {
      this._model = null;
      this._config = null;
      this._node = null;
      this._titleElement.classList.add('hidden');
      this._repaint();
      return;
    }

    this._node = node;
    const model = await node.boxModel();
    if (!model || !this._pageScaleFactor) {
      this._repaint();
      return;
    }
    this._model = this._scaleModel(model);
    this._config = config;
    this._repaint();
  }

  _refreshHighlightForCurrentFrame(): void {
    const node = this._highlightNode;
    if (!node || this._highlightRefreshPending) {
      return;
    }
    const config = this._highlightConfig;
    this._highlightRefreshPending = true;
    void node.boxModel()
        .then(model => {
          if (node !== this._highlightNode || !model || !this._pageScaleFactor) {
            return;
          }
          this._model = this._scaleModel(model);
          this._config = config;
          this._repaint();
        })
        .catch(error => {
          console.warn('Failed to refresh screencast highlight:', error);
        })
        .finally(() => {
          this._highlightRefreshPending = false;
        });
  }

  _scaleModel(model: Protocol.DOM.BoxModel): Protocol.DOM.BoxModel {
    function scaleQuad(this: ScreencastView, quad: Protocol.DOM.Quad): void {
      for (let i = 0; i < quad.length; i += 2) {
        quad[i] = quad[i] * this._pageScaleFactor * this._screenZoom;
        quad[i + 1] = (quad[i + 1] * this._pageScaleFactor + this._screenOffsetTop) * this._screenZoom;
      }
    }

    scaleQuad.call(this, model.content);
    scaleQuad.call(this, model.padding);
    scaleQuad.call(this, model.border);
    scaleQuad.call(this, model.margin);
    return model;
  }

  _repaint(): void {
    const model = this._model;
    const config = this._config;
    const preserveH264Frame = Boolean(this._h264Decoder && this._h264FrameVisible);
    const frameCanvas = this._presentedFrameCanvas();

    // Resizing a canvas reallocates and clears its backing store. Avoid doing
    // that for every frame when the screencast dimensions are unchanged.
    if (this._canvasElement.width !== this._canvasWidth || this._canvasElement.height !== this._canvasHeight) {
      this._canvasElement.width = this._canvasWidth;
      this._canvasElement.height = this._canvasHeight;
    } else if (!preserveH264Frame) {
      this._context.clearRect(0, 0, this._canvasWidth, this._canvasHeight);
    }
    this._context.globalCompositeOperation = 'source-over';
    this._context.save();

    // Paint top and bottom gutter.
    if (this._checkerboardPattern) {
      this._context.fillStyle = this._checkerboardPattern;
    }
    this._context.fillRect(0, 0, this._canvasWidth, this._screenOffsetTop * this._screenZoom);
    this._context.fillRect(
      0, this._screenOffsetTop * this._screenZoom + frameCanvas.height, this._canvasWidth,
      this._canvasHeight);
    this._context.restore();

    if (model && config) {
      this._context.save();
      const quads = [];
      const isTransparent = (color: Protocol.DOM.RGBA): boolean => Boolean(color.a && color.a === 0);
      if (model.content && config.contentColor && !isTransparent(config.contentColor)) {
        quads.push({ quad: model.content, color: config.contentColor });
      }
      if (model.padding && config.paddingColor && !isTransparent(config.paddingColor)) {
        quads.push({ quad: model.padding, color: config.paddingColor });
      }
      if (model.border && config.borderColor && !isTransparent(config.borderColor)) {
        quads.push({ quad: model.border, color: config.borderColor });
      }
      if (model.margin && config.marginColor && !isTransparent(config.marginColor)) {
        quads.push({ quad: model.margin, color: config.marginColor });
      }

      for (let i = quads.length - 1; i > 0; --i) {
        this._drawOutlinedQuadWithClip(quads[i].quad, quads[i - 1].quad, quads[i].color);
      }
      if (quads.length > 0) {
        this._drawOutlinedQuad(quads[0].quad, quads[0].color);
      }
      this._context.restore();

      this._drawElementTitle();

      this._context.globalCompositeOperation = 'destination-over';
    }

    if (!preserveH264Frame) {
      this._context.drawImage(
        frameCanvas, 0, this._screenOffsetTop * this._screenZoom,
        frameCanvas.width, frameCanvas.height);
    }
    this._context.restore();
    this._context.globalCompositeOperation = 'source-over';
  }

  _cssColor(color: Protocol.DOM.RGBA): string {
    if (!color) {
      return 'transparent';
    }
    return Common.Color.Color.fromRGBA([color.r, color.g, color.b, color.a !== undefined ? color.a : 1])
      .asString(Common.Color.Format.RGBA) ||
      '';
  }

  _quadToPath(quad: Protocol.DOM.Quad): CanvasRenderingContext2D {
    this._context.beginPath();
    this._context.moveTo(quad[0], quad[1]);
    this._context.lineTo(quad[2], quad[3]);
    this._context.lineTo(quad[4], quad[5]);
    this._context.lineTo(quad[6], quad[7]);
    this._context.closePath();
    return this._context;
  }

  _drawOutlinedQuad(quad: Protocol.DOM.Quad, fillColor: Protocol.DOM.RGBA): void {
    this._context.save();
    this._context.lineWidth = 2;
    this._quadToPath(quad).clip();
    this._context.fillStyle = this._cssColor(fillColor);
    this._context.fill();
    this._context.restore();
  }

  _drawOutlinedQuadWithClip(quad: Protocol.DOM.Quad, clipQuad: Protocol.DOM.Quad, fillColor: Protocol.DOM.RGBA): void {
    this._context.fillStyle = this._cssColor(fillColor);
    this._context.save();
    this._context.lineWidth = 0;
    this._quadToPath(quad).fill();
    this._context.globalCompositeOperation = 'destination-out';
    this._context.fillStyle = 'red';
    this._quadToPath(clipQuad).fill();
    this._context.restore();
  }

  _drawElementTitle(): void {
    if (!this._node) {
      return;
    }

    const lowerCaseName = this._node.localName() || this._node.nodeName().toLowerCase();
    this._tagNameElement.textContent = lowerCaseName;

    this._attributeElement.textContent = getAttributesForElementTitle(this._node);
    this._nodeWidthElement.textContent = String(this._model ? this._model.width : 0);
    this._nodeHeightElement.textContent = String(this._model ? this._model.height : 0);

    this._titleElement.classList.remove('hidden');
    const titleWidth = this._cssToCanvas(this._titleElement.offsetWidth + 6);
    const titleHeight = this._cssToCanvas(this._titleElement.offsetHeight + 4);

    const anchorTop = this._model ? this._model.margin[1] : 0;
    const anchorBottom = this._model ? this._model.margin[7] : 0;

    const arrowHeight = this._cssToCanvas(7);
    let renderArrowUp = false;
    let renderArrowDown = false;

    let boxX = Math.max(this._cssToCanvas(2), this._model ? this._model.margin[0] : 0);
    if (boxX + titleWidth > this._canvasWidth) {
      boxX = this._canvasWidth - titleWidth - this._cssToCanvas(2);
    }

    let boxY;
    if (anchorTop > this._canvasHeight) {
      boxY = this._canvasHeight - titleHeight - arrowHeight;
      renderArrowDown = true;
    } else if (anchorBottom < 0) {
      boxY = arrowHeight;
      renderArrowUp = true;
    } else if (anchorBottom + titleHeight + arrowHeight < this._canvasHeight) {
      boxY = anchorBottom + arrowHeight - this._cssToCanvas(4);
      renderArrowUp = true;
    } else if (anchorTop - titleHeight - arrowHeight > 0) {
      boxY = anchorTop - titleHeight - arrowHeight + this._cssToCanvas(3);
      renderArrowDown = true;
    } else {
      boxY = arrowHeight;
    }

    this._context.save();
    this._context.translate(0.5, 0.5);
    this._context.beginPath();
    this._context.moveTo(boxX, boxY);
    if (renderArrowUp) {
      this._context.lineTo(boxX + 2 * arrowHeight, boxY);
      this._context.lineTo(boxX + 3 * arrowHeight, boxY - arrowHeight);
      this._context.lineTo(boxX + 4 * arrowHeight, boxY);
    }
    this._context.lineTo(boxX + titleWidth, boxY);
    this._context.lineTo(boxX + titleWidth, boxY + titleHeight);
    if (renderArrowDown) {
      this._context.lineTo(boxX + 4 * arrowHeight, boxY + titleHeight);
      this._context.lineTo(boxX + 3 * arrowHeight, boxY + titleHeight + arrowHeight);
      this._context.lineTo(boxX + 2 * arrowHeight, boxY + titleHeight);
    }
    this._context.lineTo(boxX, boxY + titleHeight);
    this._context.closePath();
    this._context.fillStyle = 'rgb(255, 255, 194)';
    this._context.fill();
    this._context.strokeStyle = 'rgb(128, 128, 128)';
    this._context.stroke();

    this._context.restore();

    this._titleElement.style.top = (this._canvasToCss(boxY) + 3) + 'px';
    this._titleElement.style.left = (this._canvasToCss(boxX) + 3) + 'px';
  }

  get _canvasWidth(): number {
    return this._presentedFrameCanvas()?.width || this._imageElement.naturalWidth || 1;
  }

  get _canvasHeight(): number {
    return this._presentedFrameCanvas()?.height || this._imageElement.naturalHeight || 1;
  }

  _cssToCanvas(num: number): number {
    if (this._imageZoom <= 0) {
      return num;
    }
    return num / this._imageZoom;
  }

  _canvasToCss(num: number): number {
    return num * this._imageZoom;
  }

  _viewportDimensions(): { width: number, height: number } {
    const gutterSize = 30;
    const bordersSize = BORDERS_SIZE;
    const width = this.element.offsetWidth - bordersSize - gutterSize;
    const height = this.element.offsetHeight - bordersSize - gutterSize - NAVBAR_HEIGHT;
    return { width: width, height: height };
  }

  setInspectMode(mode: Protocol.Overlay.InspectMode, config: Protocol.Overlay.HighlightConfig): Promise<void> {
    this._inspectModeConfig = mode !== Protocol.Overlay.InspectMode.None ? config : null;
    return Promise.resolve();
  }

  highlightFrame(_frameId: string): void {
  }

  _createCheckerboardPattern(context: CanvasRenderingContext2D): CanvasPattern | null {
    const pattern = document.createElement('canvas') as HTMLCanvasElement;
    const size = 32;
    pattern.width = size * 2;
    pattern.height = size * 2;
    const pctx = pattern.getContext('2d') as CanvasRenderingContext2D;

    pctx.fillStyle = 'rgb(195, 195, 195)';
    pctx.fillRect(0, 0, size * 2, size * 2);

    pctx.fillStyle = 'rgb(225, 225, 225)';
    pctx.fillRect(0, 0, size, size);
    pctx.fillRect(size, size, size, size);
    return context.createPattern(pattern, 'repeat');
  }

  _createNavigationBar(): void {
    this._navigationBar = this.element.createChild('div', 'screencast-navigation') as HTMLElement;
    this._navigationBack = this._navigationBar.createChild('button', 'back') as HTMLButtonElement;
    this._navigationBack.disabled = true;
    UI.ARIAUtils.setAccessibleName(this._navigationBack, i18nString(UIStrings.back));
    this._navigationForward = this._navigationBar.createChild('button', 'forward') as HTMLButtonElement;
    this._navigationForward.disabled = true;
    UI.ARIAUtils.setAccessibleName(this._navigationForward, i18nString(UIStrings.forward));
    this._navigationReload = this._navigationBar.createChild('button', 'reload');
    UI.ARIAUtils.setAccessibleName(this._navigationReload, i18nString(UIStrings.reload));
    const reloadText = this._navigationBar.createChild('span', 'title-heigh');
    const tmp0 = document.createTextNode('Reload');
    reloadText.appendChild(tmp0);

    const spanValue = this._navigationBar.createChild('span', 'title-heigh');
    spanValue.appendChild(document.createTextNode('SD'));
    this._navigationScreenSwitch = UI.UIUtils.createInput('switch-component', 'checkbox') as HTMLInputElement;
    this._navigationScreenSwitch.style.marginLeft = '19px';
    this._navigationScreenSwitch.checked = localStorage.getItem('isHD') === 'true';
    spanValue.appendChild(this._navigationScreenSwitch);
    const spanValue2 = this._navigationBar.createChild('span', 'title-low');
    spanValue2.appendChild(document.createTextNode('HD'));

    const screencastModeLynx = this._navigationBar.createChild('span', 'title-heigh');
    screencastModeLynx.style.marginLeft = '10px';
    screencastModeLynx.appendChild(document.createTextNode('LynxView'));
    this._navigationScreenCastModeSwitch = UI.UIUtils.createInput('switch-component', 'checkbox') as HTMLInputElement;
    this._navigationScreenCastModeSwitch.checked = Common.Settings.Settings.instance().createSetting<string>('pageScreencastMode', 'fullscreen').get() === 'fullscreen';
    this._navigationScreenCastModeSwitch.style.marginLeft = '54px';
    screencastModeLynx.appendChild(this._navigationScreenCastModeSwitch);
    const screencastModeFullScreen = this._navigationBar.createChild('span', 'title-low');
    screencastModeFullScreen.appendChild(document.createTextNode('FullScreen'));

    const betterScreencastToggle = this._navigationBar.createChild('label', 'screencast-pipeline-toggle');
    betterScreencastToggle.appendChild(document.createTextNode('Old'));
    this._navigationBetterScreencastSwitch =
        UI.UIUtils.createInput('switch-component screencast-pipeline-switch', 'checkbox') as HTMLInputElement;
    this._navigationBetterScreencastSwitch.checked =
        Common.Settings.Settings.instance().createSetting<boolean>('enableBetterScreencast', true).get();
    UI.ARIAUtils.setAccessibleName(
        this._navigationBetterScreencastSwitch, i18nString(UIStrings.betterScreencast));
    betterScreencastToggle.appendChild(this._navigationBetterScreencastSwitch);
    betterScreencastToggle.appendChild(document.createTextNode('New'));

    const webGLReconstructionToggle = this._navigationBar.createChild('label', 'screencast-pipeline-toggle');
    webGLReconstructionToggle.appendChild(document.createTextNode('Native'));
    this._navigationWebGLReconstructionSwitch =
        UI.UIUtils.createInput('switch-component screencast-pipeline-switch', 'checkbox') as HTMLInputElement;
    this._navigationWebGLReconstructionSwitch.checked = Common.Settings.Settings.instance()
        .createSetting<boolean>('enableScreencastWebGLReconstruction', false).get();
    UI.ARIAUtils.setAccessibleName(
        this._navigationWebGLReconstructionSwitch, i18nString(UIStrings.webGLReconstruction));
    webGLReconstructionToggle.appendChild(this._navigationWebGLReconstructionSwitch);
    webGLReconstructionToggle.appendChild(document.createTextNode('FSR'));
    const gateToggle = this._navigationBar.createChild('label', 'screencast-pipeline-toggle');
    gateToggle.appendChild(document.createTextNode('跳过静态'));
    this._navigationFrameSignalGateSwitch =
        UI.UIUtils.createInput('switch-component screencast-pipeline-switch', 'checkbox') as HTMLInputElement;
    this._navigationFrameSignalGateSwitch.checked = Common.Settings.Settings.instance()
        .createSetting<boolean>('enableFrameSignalGate', false).get();
    UI.ARIAUtils.setAccessibleName(this._navigationFrameSignalGateSwitch,
        '跳过静态：无新帧信号时跳过采集，每秒兜底截图一次，仅 New 模式生效');
    gateToggle.appendChild(this._navigationFrameSignalGateSwitch);
    this._navigationFrameSignalGateSwitch.addEventListener('change', () => {
      Common.Settings.Settings.instance().createSetting<boolean>('enableFrameSignalGate', false)
          .set(this._navigationFrameSignalGateSwitch?.checked ?? false);
      this._stopCasting();
      this._startCasting();
    });
    this._updateScreencastControlState();

    this._navigationUrl = UI.UIUtils.createInput() as HTMLInputElement;
    UI.ARIAUtils.setAccessibleName(this._navigationUrl, i18nString(UIStrings.addressBar));
    this._navigationBar.appendChild(this._navigationUrl);
    this._navigationUrl.type = 'text';
    this._navigationProgressBar = new ProgressTracker(
      this._resourceTreeModel, this._networkManager,
      this._navigationBar.createChild('div', 'progress') as HTMLElement);

    if (this._resourceTreeModel) {
      this._navigationBack.addEventListener('click', this._navigateToHistoryEntry.bind(this, -1), false);
      this._navigationForward.addEventListener('click', this._navigateToHistoryEntry.bind(this, 1), false);
      this._navigationReload.addEventListener('click', this._navigateReload.bind(this), false);
      this._navigationScreenSwitch.addEventListener('click', this._navigateScreenCastQuality.bind(this), false);
      this._navigationScreenCastModeSwitch?.addEventListener('click', this._navigationScreenCastModeChange.bind(this));
      this._navigationBetterScreencastSwitch?.addEventListener(
          'change', this._navigationBetterScreencastChange.bind(this));
      this._navigationWebGLReconstructionSwitch?.addEventListener(
          'change', this._navigationWebGLReconstructionChange.bind(this));
      this._navigationUrl.addEventListener('keyup', this._navigationUrlKeyUp.bind(this), true);
      this._requestNavigationHistory();
      this._resourceTreeModel.addEventListener(
        SDK.ResourceTreeModel.Events.MainFrameNavigated, this._requestNavigationHistoryEvent, this);
      this._resourceTreeModel.addEventListener(
        SDK.ResourceTreeModel.Events.CachedResourcesLoaded, this._requestNavigationHistoryEvent, this);
    }
  }

  _navigateToHistoryEntry(offset: number): void {
    if (!this._resourceTreeModel) {
      return;
    }
    const newIndex = (this._historyIndex || 0) + offset;
    if (!this._historyEntries || newIndex < 0 || newIndex >= this._historyEntries.length) {
      return;
    }
    this._resourceTreeModel.navigateToHistoryEntry(this._historyEntries[newIndex]);
    this._requestNavigationHistory();
  }

  _navigateReload(): void {
    if (!this._resourceTreeModel) {
      return;
    }
    if (!Common.Settings.Settings.instance().moduleSetting('preserveConsoleLog').get()) {
      SDK.ConsoleModel.ConsoleModel.instance()._clear();
    }
    this._resourceTreeModel.reloadPage();
    // Business logic: a11y barrier-free label
    Host.InspectorFrontendHost.sendWindowMessage({
      type: 'a11y_mark_lynx',
      content: {
        type: 'a11y_start_mark',
        // @ts-ignore
        message: window.sessionUrl,
      },
    });
  }
  _navigateScreenCastQuality(event: MouseEvent): void {
    const isHD = (event.target as HTMLInputElement).checked ? 'true' : 'false';
    localStorage.setItem('isHD', isHD);
    this._stopCasting();
    this._startCasting();
  }
  _navigationScreenCastModeChange(event: MouseEvent): void {
    const mode = (event.target as HTMLInputElement).checked ? 'fullscreen' : 'lynxview';
    Common.Settings.Settings.instance().createSetting<string>('pageScreencastMode', 'fullscreen').set(mode);
    this._updateScreencastControlState();
    this._stopCasting();
    this._startCasting();
  }
  _navigationBetterScreencastChange(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    Common.Settings.Settings.instance().createSetting<boolean>('enableBetterScreencast', true).set(enabled);
    this._updateScreencastControlState();
    this._stopCasting();
    this._frameContext.clearRect(0, 0, this._frameCanvas.width, this._frameCanvas.height);
    this._startCasting();
  }
  _navigationWebGLReconstructionChange(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    Common.Settings.Settings.instance()
        .createSetting<boolean>('enableScreencastWebGLReconstruction', false).set(enabled);
    this._updateScreencastControlState();
    this._stopCasting();
    this._frameContext.clearRect(0, 0, this._frameCanvas.width, this._frameCanvas.height);
    this._startCasting();
  }
  _updateScreencastControlState(): void {
    const betterEnabled = this._navigationBetterScreencastSwitch?.checked ?? false;
    if (this._navigationFrameSignalGateSwitch) {
      this._navigationFrameSignalGateSwitch.disabled = !betterEnabled;
    }
    if (this._navigationWebGLReconstructionSwitch) {
      this._navigationWebGLReconstructionSwitch.disabled = !betterEnabled;
    }
  }
  _navigationUrlKeyUp(event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    let url: string = this._navigationUrl.value;
    if (!url) {
      return;
    }
    if (!url.match(SCHEME_REGEX)) {
      url = 'http://' + url;
    }

    // Perform decodeURI in case the user enters an encoded string
    // decodeURI has no effect on strings that are already decoded
    // encodeURI ensures an encoded URL is always passed to the backend
    // This allows the input field to support both encoded and decoded URLs
    if (this._resourceTreeModel) {
      this._resourceTreeModel.navigate(encodeURI(decodeURI(url)));
    }
    this._canvasElement.focus();
  }

  _requestNavigationHistoryEvent(_event: Common.EventTarget.EventTargetEvent): void {
    this._requestNavigationHistory();
  }

  async _requestNavigationHistory(): Promise<void> {
    const history = this._resourceTreeModel ? await this._resourceTreeModel.navigationHistory() : null;
    if (!history) {
      return;
    }

    this._historyIndex = history.currentIndex;
    this._historyEntries = history.entries;

    this._navigationBack.disabled = this._historyIndex === 0;
    this._navigationForward.disabled = this._historyIndex === (this._historyEntries.length - 1);

    let url: string = this._historyEntries[this._historyIndex].url;
    const match = url.match(HTTP_REGEX);
    if (match) {
      url = match[1];
    }
    Host.InspectorFrontendHost.InspectorFrontendHostInstance.inspectedURLChanged(url);
    this._navigationUrl.value = decodeURI(url);
  }

  _focusNavigationBar(): boolean {
    this._navigationUrl.focus();
    this._navigationUrl.select();
    return true;
  }
}

export const BORDERS_SIZE = 44;
export const NAVBAR_HEIGHT = 29;
export const HTTP_REGEX = /^http:\/\/(.+)/;
export const SCHEME_REGEX = /^(https?|about|chrome):/;

export class ProgressTracker {
  _element: HTMLElement;
  _requestIds: Map<string, SDK.NetworkRequest.NetworkRequest> | null;
  _startedRequests: number;
  _finishedRequests: number;
  _maxDisplayedProgress: number;

  constructor(
    resourceTreeModel: SDK.ResourceTreeModel.ResourceTreeModel | null,
    networkManager: SDK.NetworkManager.NetworkManager | null, element: HTMLElement) {
    this._element = element;
    if (resourceTreeModel) {
      resourceTreeModel.addEventListener(
        SDK.ResourceTreeModel.Events.MainFrameNavigated, this._onMainFrameNavigated, this);
      resourceTreeModel.addEventListener(SDK.ResourceTreeModel.Events.Load, this._onLoad, this);
    }
    if (networkManager) {
      networkManager.addEventListener(SDK.NetworkManager.Events.RequestStarted, this._onRequestStarted, this);
      networkManager.addEventListener(SDK.NetworkManager.Events.RequestFinished, this._onRequestFinished, this);
    }
    this._requestIds = null;
    this._startedRequests = 0;
    this._finishedRequests = 0;
    this._maxDisplayedProgress = 0;
  }

  _onMainFrameNavigated(): void {
    this._requestIds = new Map();
    this._startedRequests = 0;
    this._finishedRequests = 0;
    this._maxDisplayedProgress = 0;
    this._updateProgress(0.1);  // Display first 10% on navigation start.
  }

  _onLoad(): void {
    this._requestIds = null;
    this._updateProgress(1);  // Display 100% progress on load, hide it in 0.5s.
    setTimeout(() => {
      if (!this._navigationProgressVisible()) {
        this._displayProgress(0);
      }
    }, 500);
  }

  _navigationProgressVisible(): boolean {
    return this._requestIds !== null;
  }

  _onRequestStarted(event: Common.EventTarget.EventTargetEvent): void {
    if (!this._navigationProgressVisible()) {
      return;
    }
    const request = event.data.request as SDK.NetworkRequest.NetworkRequest;
    // Ignore long-living WebSockets for the sake of progress indicator, as we won't be waiting them anyway.
    if (request.resourceType() === Common.ResourceType.resourceTypes.WebSocket) {
      return;
    }
    if (this._requestIds) {
      this._requestIds.set(request.requestId(), request);
    }
    ++this._startedRequests;
  }

  _onRequestFinished(event: Common.EventTarget.EventTargetEvent): void {
    if (!this._navigationProgressVisible()) {
      return;
    }
    const request = event.data as SDK.NetworkRequest.NetworkRequest;
    if (this._requestIds && !this._requestIds.has(request.requestId())) {
      return;
    }
    ++this._finishedRequests;
    setTimeout(() => {
      this._updateProgress(
        this._finishedRequests / this._startedRequests * 0.9);  // Finished requests drive the progress up to 90%.
    }, 500);  // Delay to give the new requests time to start. This makes the progress smoother.
  }

  _updateProgress(progress: number): void {
    if (!this._navigationProgressVisible()) {
      return;
    }
    if (this._maxDisplayedProgress >= progress) {
      return;
    }
    this._maxDisplayedProgress = progress;
    this._displayProgress(progress);
  }

  _displayProgress(progress: number): void {
    this._element.style.width = (100 * progress) + '%';
  }
}

function getAttributesForElementTitle(node: SDK.DOMModel.DOMNode): string {
  const id = node.getAttribute('id');
  const className = node.getAttribute('class');

  let selector: string = id ? '#' + id : '';
  if (className) {
    selector += '.' + className.trim().replace(/\s+/g, '.');
  }

  if (selector.length > 50) {
    selector = selector.substring(0, 50) + '…';
  }

  return selector;
}
