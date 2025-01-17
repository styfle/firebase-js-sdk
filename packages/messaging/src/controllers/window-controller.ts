/**
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FirebaseApp } from '@firebase/app-types';
import {
  CompleteFn,
  createSubscribe,
  ErrorFn,
  NextFn,
  Observer,
  Subscribe,
  Unsubscribe
} from '@firebase/util';

import { base64ToArrayBuffer } from '../helpers/base64-to-array-buffer';
import { DEFAULT_SW_PATH, DEFAULT_SW_SCOPE } from '../models/default-sw';
import { ErrorCode, errorFactory } from '../models/errors';
import { DEFAULT_PUBLIC_VAPID_KEY } from '../models/fcm-details';
import {
  InternalMessage,
  MessageParameter,
  MessageType
} from '../models/worker-page-message';
import { BaseController } from './base-controller';

export class WindowController extends BaseController {
  private registrationToUse: ServiceWorkerRegistration | null = null;
  private publicVapidKeyToUse: Uint8Array | null = null;

  private messageObserver: Observer<object> | null = null;
  // @ts-ignore: Unused variable error, this is not implemented yet.
  private tokenRefreshObserver: Observer<object> | null = null;

  private readonly onMessageInternal: Subscribe<object> = createSubscribe(
    observer => {
      this.messageObserver = observer;
    }
  );

  private readonly onTokenRefreshInternal: Subscribe<object> = createSubscribe(
    observer => {
      this.tokenRefreshObserver = observer;
    }
  );

  /**
   * A service that provides a MessagingService instance.
   */
  constructor(app: FirebaseApp) {
    super(app);

    this.setupSWMessageListener_();
  }

  /**
   * Request permission if it is not currently granted
   *
   * @return Resolves if the permission was granted, otherwise rejects
   *
   * @deprecated Use Notification.requestPermission() instead.
   * https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission
   */
  async requestPermission(): Promise<void> {
    if (this.getNotificationPermission_() === 'granted') {
      return;
    }

    const permissionResult = await Notification.requestPermission();
    if (permissionResult === 'granted') {
      return;
    } else if (permissionResult === 'denied') {
      throw errorFactory.create(ErrorCode.PERMISSION_BLOCKED);
    } else {
      throw errorFactory.create(ErrorCode.PERMISSION_DEFAULT);
    }
  }

  /**
   * This method allows a developer to override the default service worker and
   * instead use a custom service worker.
   *
   * @param registration The service worker registration that should be used to
   * receive the push messages.
   */
  useServiceWorker(registration: ServiceWorkerRegistration): void {
    if (!(registration instanceof ServiceWorkerRegistration)) {
      throw errorFactory.create(ErrorCode.SW_REGISTRATION_EXPECTED);
    }

    if (this.registrationToUse != null) {
      throw errorFactory.create(ErrorCode.USE_SW_BEFORE_GET_TOKEN);
    }

    this.registrationToUse = registration;
  }

  /**
   * This method allows a developer to override the default vapid key
   * and instead use a custom VAPID public key.
   *
   * @param publicKey A URL safe base64 encoded string.
   */
  usePublicVapidKey(publicKey: string): void {
    if (typeof publicKey !== 'string') {
      throw errorFactory.create(ErrorCode.INVALID_PUBLIC_VAPID_KEY);
    }

    if (this.publicVapidKeyToUse != null) {
      throw errorFactory.create(ErrorCode.USE_PUBLIC_KEY_BEFORE_GET_TOKEN);
    }

    const parsedKey = base64ToArrayBuffer(publicKey);

    if (parsedKey.length !== 65) {
      throw errorFactory.create(ErrorCode.PUBLIC_KEY_DECRYPTION_FAILED);
    }

    this.publicVapidKeyToUse = parsedKey;
  }

  /**
   * @export
   * @param nextOrObserver An observer object or a function triggered on
   * message.
   * @param error A function triggered on message error.
   * @param completed function triggered when the observer is removed.
   * @return The unsubscribe function for the observer.
   */
  onMessage(
    nextOrObserver: NextFn<object> | Observer<object>,
    error?: ErrorFn,
    completed?: CompleteFn
  ): Unsubscribe {
    if (typeof nextOrObserver === 'function') {
      return this.onMessageInternal(nextOrObserver, error, completed);
    } else {
      return this.onMessageInternal(nextOrObserver);
    }
  }

  /**
   * @param nextOrObserver An observer object or a function triggered on token
   * refresh.
   * @param error A function triggered on token refresh error.
   * @param completed function triggered when the observer is removed.
   * @return The unsubscribe function for the observer.
   */
  onTokenRefresh(
    nextOrObserver: NextFn<object> | Observer<object>,
    error?: ErrorFn,
    completed?: CompleteFn
  ): Unsubscribe {
    if (typeof nextOrObserver === 'function') {
      return this.onTokenRefreshInternal(nextOrObserver, error, completed);
    } else {
      return this.onTokenRefreshInternal(nextOrObserver);
    }
  }

  /**
   * Given a registration, wait for the service worker it relates to
   * become activer
   * @param registration Registration to wait for service worker to become active
   * @return Wait for service worker registration to become active
   */
  // Visible for testing
  // TODO: Make private
  waitForRegistrationToActivate_(
    registration: ServiceWorkerRegistration
  ): Promise<ServiceWorkerRegistration> {
    const serviceWorker =
      registration.installing || registration.waiting || registration.active;

    return new Promise<ServiceWorkerRegistration>((resolve, reject) => {
      if (!serviceWorker) {
        // This is a rare scenario but has occured in firefox
        reject(errorFactory.create(ErrorCode.NO_SW_IN_REG));
        return;
      }
      // Because the Promise function is called on next tick there is a
      // small chance that the worker became active or redundant already.
      if (serviceWorker.state === 'activated') {
        resolve(registration);
        return;
      }

      if (serviceWorker.state === 'redundant') {
        reject(errorFactory.create(ErrorCode.SW_REG_REDUNDANT));
        return;
      }

      const stateChangeListener = (): void => {
        if (serviceWorker.state === 'activated') {
          resolve(registration);
        } else if (serviceWorker.state === 'redundant') {
          reject(errorFactory.create(ErrorCode.SW_REG_REDUNDANT));
        } else {
          // Return early and wait to next state change
          return;
        }
        serviceWorker.removeEventListener('statechange', stateChangeListener);
      };
      serviceWorker.addEventListener('statechange', stateChangeListener);
    });
  }

  /**
   * This will register the default service worker and return the registration
   * @return The service worker registration to be used for the push service.
   */
  getSWRegistration_(): Promise<ServiceWorkerRegistration> {
    if (this.registrationToUse) {
      return this.waitForRegistrationToActivate_(this.registrationToUse);
    }

    // Make the registration null so we know useServiceWorker will not
    // use a new service worker as registrationToUse is no longer undefined
    this.registrationToUse = null;

    return navigator.serviceWorker
      .register(DEFAULT_SW_PATH, {
        scope: DEFAULT_SW_SCOPE
      })
      .catch((err: Error) => {
        throw errorFactory.create(ErrorCode.FAILED_DEFAULT_REGISTRATION, {
          browserErrorMessage: err.message
        });
      })
      .then((registration: ServiceWorkerRegistration) => {
        return this.waitForRegistrationToActivate_(registration).then(() => {
          this.registrationToUse = registration;

          // We update after activation due to an issue with Firefox v49 where
          // a race condition occassionally causes the service worker to not
          // install
          // tslint:disable-next-line:no-floating-promises
          registration.update();

          return registration;
        });
      });
  }

  /**
   * This will return the default VAPID key or the uint8array version of the public VAPID key
   * provided by the developer.
   */
  async getPublicVapidKey_(): Promise<Uint8Array> {
    if (this.publicVapidKeyToUse) {
      return this.publicVapidKeyToUse;
    }

    return DEFAULT_PUBLIC_VAPID_KEY;
  }

  /**
   * This method will set up a message listener to handle
   * events from the service worker that should trigger
   * events in the page.
   */
  // Visible for testing
  // TODO: Make private
  setupSWMessageListener_(): void {
    navigator.serviceWorker.addEventListener(
      'message',
      event => {
        if (!event.data || !event.data[MessageParameter.TYPE_OF_MSG]) {
          // Not a message from FCM
          return;
        }

        const workerPageMessage: InternalMessage = event.data;
        switch (workerPageMessage[MessageParameter.TYPE_OF_MSG]) {
          case MessageType.PUSH_MSG_RECEIVED:
          case MessageType.NOTIFICATION_CLICKED:
            const pushMessage = workerPageMessage[MessageParameter.DATA];
            if (this.messageObserver) {
              this.messageObserver.next(pushMessage);
            }
            break;
          default:
            // Noop.
            break;
        }
      },
      false
    );
  }
}
