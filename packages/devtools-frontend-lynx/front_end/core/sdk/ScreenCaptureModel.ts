// Copyright 2017 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Copyright 2025 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

/* eslint-disable rulesdir/no_underscored_properties */

import type * as ProtocolProxyApi from '../../generated/protocol-proxy-api.js';
import type * as Protocol from '../../generated/protocol.js';
import * as Common from '../common/common.js';

import {OverlayModel} from './OverlayModel.js';
import type {Target} from './Target.js';
import {Capability} from './Target.js';
import {SDKModel} from './SDKModel.js';
import { envLogger } from '../protocol_client/InspectorBackend.js';

export class ScreenCaptureModel extends SDKModel implements ProtocolProxyApi.PageDispatcher {
  _agent: ProtocolProxyApi.PageApi;
  _screencastAckTimeout: number|null;
  _lastScreencastAckTime: number;
  _screencastGeneration: number;
  _screencastPresentationChain: Promise<void>;
  _activeScreencastStreamId: number|null;
  _cachedScreencastFrame: Protocol.Page.ScreencastFrameEvent | null;
  _onScreencastFrame:
      ((arg0: Protocol.binary, arg1: Protocol.Page.ScreencastFrameMetadata) => void|Promise<void>)|null;
  _onScreencastVisibilityChanged: ((arg0: boolean) => void)|null;
  _onScreencastStateChanged: ((arg0: Protocol.Page.ScreencastStateChangedEvent) => void)|null;
  _screencastCapturePaused: boolean;
  _pendingScreencastAck: {
    sessionId: number,
    streamId: number|undefined,
    generation: number,
    onFrame: (arg0: Protocol.binary, arg1: Protocol.Page.ScreencastFrameMetadata) => void|Promise<void>,
  }|null;
  constructor(target: Target) {
    super(target);
    this._agent = target.pageAgent();
    this._screencastAckTimeout = null;
    this._lastScreencastAckTime = 0;
    this._screencastGeneration = 0;
    this._screencastPresentationChain = Promise.resolve();
    this._activeScreencastStreamId = null;
    this._cachedScreencastFrame = null;
    this._onScreencastFrame = null;
    this._onScreencastVisibilityChanged = null;
    this._onScreencastStateChanged = null;
    this._screencastCapturePaused = false;
    this._pendingScreencastAck = null;
    target.registerPageDispatcher(this);
  }

  startScreencast(
      format: Protocol.Page.StartScreencastRequestFormat, quality: number, maxWidth: number|undefined,
      maxHeight: number|undefined, everyNthFrame: number|undefined,
      onFrame: (arg0: Protocol.binary, arg1: Protocol.Page.ScreencastFrameMetadata) => void|Promise<void>,
      onVisibilityChanged: (arg0: boolean) => void,
      onStateChanged?: (arg0: Protocol.Page.ScreencastStateChangedEvent) => void,
      retryCapturePermission = false, enableBetterScreencast = false, enableFrameSignalGate = false): void {
    this._onScreencastFrame = onFrame;
    this._onScreencastVisibilityChanged = onVisibilityChanged;
    this._onScreencastStateChanged = onStateChanged ?? null;
    if (this._screencastAckTimeout) {
      clearTimeout(this._screencastAckTimeout);
      this._screencastAckTimeout = null;
    }
    this._lastScreencastAckTime = 0;
    this._screencastGeneration++;
    // A decoder callback from the previous stream may never settle after a
    // target switch. The new stream must not queue behind that stale promise.
    this._screencastPresentationChain = Promise.resolve();
    this._activeScreencastStreamId = null;
    this._screencastCapturePaused = false;
    this._pendingScreencastAck = null;
    const generation = this._screencastGeneration;
    const mode = Common.Settings.Settings.instance().createSetting<string>('pageScreencastMode', 'fullscreen').get();
    const h264Requested = format === 'h264';
    const legacyFormat = h264Requested ? 'jpeg' as Protocol.Page.StartScreencastRequestFormat : format;
    const preferredFormats = h264Requested ?
        [
          'h264' as Protocol.Page.StartScreencastRequestPreferredFormats,
          'jpeg' as Protocol.Page.StartScreencastRequestPreferredFormats,
        ] :
        [format as unknown as Protocol.Page.StartScreencastRequestPreferredFormats];
    void this._agent.invoke_startScreencast({
      format: legacyFormat,
      preferredFormats,
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame,
      targetFps: h264Requested ? 30 : undefined,
      mode,
      retryCapturePermission,
      enableBetterScreencast,
      enableFrameSignalGate,
    }).then(response => {
      if (generation === this._screencastGeneration && !response.getError()) {
        this._activeScreencastStreamId = response.streamId;
      }
    });
    if (this._cachedScreencastFrame) {
      const cachedFrame = this._cachedScreencastFrame;
      this._screencastPresentationChain = this._screencastPresentationChain.then(async () => {
        if (generation !== this._screencastGeneration || onFrame !== this._onScreencastFrame) {
          return;
        }
        await onFrame(cachedFrame.data, cachedFrame.metadata);
      });
      envLogger.info('CachedScreencastFrame is used to call onScreencastFrame', {
        tag: 'Screencast',
      });
    }
  }

  stopScreencast(): void {
    this._onScreencastFrame = null;
    this._onScreencastVisibilityChanged = null;
    this._onScreencastStateChanged = null;
    if (this._screencastAckTimeout) {
      clearTimeout(this._screencastAckTimeout);
      this._screencastAckTimeout = null;
    }
    this._lastScreencastAckTime = 0;
    this._activeScreencastStreamId = null;
    this._screencastCapturePaused = false;
    this._pendingScreencastAck = null;
    this._screencastGeneration++;
    this._screencastPresentationChain = Promise.resolve();
    this._agent.invoke_stopScreencast();
  }

  setScreencastCapturePaused(paused: boolean): void {
    if (this._screencastCapturePaused === paused) {
      return;
    }
    this._screencastCapturePaused = paused;
    if (paused || !this._pendingScreencastAck) {
      return;
    }
    const pendingAck = this._pendingScreencastAck;
    this._pendingScreencastAck = null;
    this._acknowledgeScreencastFrame(
        pendingAck.sessionId, pendingAck.streamId, pendingAck.generation, pendingAck.onFrame);
  }

  async captureScreenshot(
      format: Protocol.Page.CaptureScreenshotRequestFormat, quality: number,
      clip?: Protocol.Page.Viewport): Promise<string|null> {
    await OverlayModel.muteHighlight();
    const result = await this._agent.invoke_captureScreenshot(
        {format, quality, clip, fromSurface: true, captureBeyondViewport: true});
    await OverlayModel.unmuteHighlight();
    return result.data;
  }

  async fetchLayoutMetrics(): Promise<{
    viewportX: number,
    viewportY: number,
    viewportScale: number,
    contentWidth: number,
    contentHeight: number,
  }|null> {
    const response = await this._agent.invoke_getLayoutMetrics();
    if (response.getError()) {
      return null;
    }
    return {
      viewportX: response.cssVisualViewport.pageX,
      viewportY: response.cssVisualViewport.pageY,
      viewportScale: response.cssVisualViewport.scale,
      contentWidth: response.cssContentSize.width,
      contentHeight: response.cssContentSize.height,
    };
  }

  screencastFrame({data, metadata, sessionId}: Protocol.Page.ScreencastFrameEvent): void {
    if (metadata.streamId !== undefined) {
      if (this._activeScreencastStreamId !== null && metadata.streamId !== this._activeScreencastStreamId) {
        return;
      }
      this._activeScreencastStreamId = metadata.streamId;
    }
    // A delta payload is meaningful only together with the already composed
    // base frame. Cache full frames only, otherwise reopening screencast could
    // render a patch as if it were a complete screenshot.
    const frame = metadata.lynxFrame;
    if (metadata.format !== 'h264' && metadata.codec !== 'h264' && frame?.frameType !== 'delta') {
      this._cachedScreencastFrame = {
        data,
        metadata,
        sessionId,
      };
    }
    const generation = this._screencastGeneration;
    const onFrame = this._onScreencastFrame;
    if (metadata.format === 'h264' || metadata.codec === 'h264') {
      // Video chunks form a continuous decoder input, not an ACK-paced image
      // presentation queue. Feed WebCodecs immediately so a busy microtask
      // chain cannot turn transport jitter into accumulated live-view delay.
      if (onFrame && generation === this._screencastGeneration) {
        void this._consumeScreencastFrame(data, metadata, sessionId, generation, onFrame);
      }
      return;
    }
    this._screencastPresentationChain = this._screencastPresentationChain.then(async () => {
      if (!onFrame || generation !== this._screencastGeneration || onFrame !== this._onScreencastFrame) {
        return;
      }
      await this._consumeScreencastFrame(data, metadata, sessionId, generation, onFrame);
    });
  }

  async _consumeScreencastFrame(
      data: Protocol.binary, metadata: Protocol.Page.ScreencastFrameMetadata, sessionId: number,
      generation: number,
      onFrame: (arg0: Protocol.binary, arg1: Protocol.Page.ScreencastFrameMetadata) => void|Promise<void>): Promise<void> {

    // The consumer resolves only after image decode and canvas drawing. This
    // makes ACK the actual backpressure signal instead of a fixed frame clock.
    try {
      await onFrame.call(null, data, metadata);
    } catch (error) {
      console.error('Failed to present screencast frame:', error);
      envLogger.error('Failed to present screencast frame.', {tag: 'Screencast'});
    }
    if (generation !== this._screencastGeneration || onFrame !== this._onScreencastFrame) {
      return;
    }

    // H.264 is a continuous encoded video stream. Its chunks are not
    // screenshot requests and must neither wait for nor emit per-frame ACKs.
    if (metadata.format === 'h264' || metadata.codec === 'h264') {
      return;
    }

    envLogger.info('call onScreencastFrame callback', {tag: 'Screencast'});
    const configuredFPS =
        parseInt(Common.Settings.Settings.instance().moduleSetting<string>('screencastFrameRateLimit').get(), 10);
    if (Number.isFinite(configuredFPS) && configuredFPS > 0) {
      const frameInterval = 1000 / configuredFPS;
      const pipelineCost =
          this._lastScreencastAckTime > 0 ? performance.now() - this._lastScreencastAckTime : frameInterval;
      const ackWaitTime = Math.max(0, frameInterval - pipelineCost);
      if (ackWaitTime > 0) {
        this._screencastAckTimeout = window.setTimeout(() => {
          this._screencastAckTimeout = null;
          this._acknowledgeScreencastFrame(sessionId, metadata.streamId, generation, onFrame);
        }, ackWaitTime);
        return;
      }
    }

    this._acknowledgeScreencastFrame(sessionId, metadata.streamId, generation, onFrame);
  }

  _acknowledgeScreencastFrame(
      sessionId: number, streamId: number|undefined, generation: number,
      onFrame: (arg0: Protocol.binary, arg1: Protocol.Page.ScreencastFrameMetadata) => void|Promise<void>): void {
    if (generation !== this._screencastGeneration || onFrame !== this._onScreencastFrame) {
      return;
    }
    if (this._screencastCapturePaused) {
      this._pendingScreencastAck = {sessionId, streamId, generation, onFrame};
      return;
    }
    this._pendingScreencastAck = null;
    this._lastScreencastAckTime = performance.now();
    void this._agent.invoke_screencastFrameAck({sessionId, streamId});
  }

  screencastVisibilityChanged({visible}: Protocol.Page.ScreencastVisibilityChangedEvent): void {
    if (this._onScreencastVisibilityChanged) {
      this._onScreencastVisibilityChanged.call(null, visible);
    }
  }

  screencastStateChanged(event: Protocol.Page.ScreencastStateChangedEvent): void {
    const {streamId, state} = event;
    if (this._activeScreencastStreamId !== null && streamId !== this._activeScreencastStreamId) {
      return;
    }
    this._activeScreencastStreamId = streamId;
    this._onScreencastStateChanged?.call(null, event);
    if (state === 'negotiating') {
      this._cachedScreencastFrame = null;
    }
    if (state === 'stopped' || state === 'failed') {
      this._activeScreencastStreamId = null;
    }
  }

  backForwardCacheNotUsed(_params: Protocol.Page.BackForwardCacheNotUsedEvent): void {
  }

  domContentEventFired(_params: Protocol.Page.DomContentEventFiredEvent): void {
  }

  loadEventFired(_params: Protocol.Page.LoadEventFiredEvent): void {
  }

  lifecycleEvent(_params: Protocol.Page.LifecycleEventEvent): void {
  }

  navigatedWithinDocument(_params: Protocol.Page.NavigatedWithinDocumentEvent): void {
  }

  frameAttached(_params: Protocol.Page.FrameAttachedEvent): void {
  }

  frameNavigated(_params: Protocol.Page.FrameNavigatedEvent): void {
  }

  documentOpened(_params: Protocol.Page.DocumentOpenedEvent): void {
  }

  frameDetached(_params: Protocol.Page.FrameDetachedEvent): void {
  }

  frameStartedLoading(_params: Protocol.Page.FrameStartedLoadingEvent): void {
  }

  frameStoppedLoading(_params: Protocol.Page.FrameStoppedLoadingEvent): void {
  }

  frameRequestedNavigation(_params: Protocol.Page.FrameRequestedNavigationEvent): void {
  }

  frameScheduledNavigation(_params: Protocol.Page.FrameScheduledNavigationEvent): void {
  }

  frameClearedScheduledNavigation(_params: Protocol.Page.FrameClearedScheduledNavigationEvent): void {
  }

  frameResized(): void {
  }

  javascriptDialogOpening(_params: Protocol.Page.JavascriptDialogOpeningEvent): void {
  }

  javascriptDialogClosed(_params: Protocol.Page.JavascriptDialogClosedEvent): void {
  }

  interstitialShown(): void {
  }

  interstitialHidden(): void {
  }

  windowOpen(_params: Protocol.Page.WindowOpenEvent): void {
  }

  fileChooserOpened(_params: Protocol.Page.FileChooserOpenedEvent): void {
  }

  compilationCacheProduced(_params: Protocol.Page.CompilationCacheProducedEvent): void {
  }

  downloadWillBegin(_params: Protocol.Page.DownloadWillBeginEvent): void {
  }

  downloadProgress(): void {
  }
}

SDKModel.register(ScreenCaptureModel, {capabilities: Capability.ScreenCapture, autostart: false});
