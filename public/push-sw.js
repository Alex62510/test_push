/* eslint-disable no-undef */
/**
 * Service Worker для Web Push (положить в /push-sw.js на сайте клиента).
 * Payload: { title, body, url, image_url } или custom_data/data с url/image.
 */
(function () {
    'use strict';

    var DEFAULT_PUSH_ICON_DATA_URI =
        'data:image/svg+xml,' +
        encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">' +
            '<defs><linearGradient id="g" x1="96" y1="16" x2="96" y2="176" gradientUnits="userSpaceOnUse">' +
            '<stop offset="0" stop-color="#FFD54F"/><stop offset="1" stop-color="#FF9800"/></linearGradient></defs>' +
            '<rect width="192" height="192" rx="44" fill="url(#g)"/>' +
            '<circle cx="96" cy="96" r="54" fill="none" stroke="#fff" stroke-width="5"/>' +
            '<path d="M42 96h108M96 42c15 17 24 37 24 54s-9 37-24 54M96 42c-15 17 24 37 24 54s9 37 24 54" ' +
            'fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>'
        );

    function asString(value) {
        if (value == null) {
            return '';
        }
        return String(value).trim();
    }

    function flattenPushRoot(raw) {
        if (!raw || typeof raw !== 'object') {
            return {};
        }
        var merged = {};
        var i;
        for (i in raw) {
            if (Object.prototype.hasOwnProperty.call(raw, i)) {
                merged[i] = raw[i];
            }
        }
        if (raw.notification && typeof raw.notification === 'object') {
            for (i in raw.notification) {
                if (Object.prototype.hasOwnProperty.call(raw.notification, i) && merged[i] == null) {
                    merged[i] = raw.notification[i];
                }
            }
        }
        if (raw.data && typeof raw.data === 'object') {
            for (i in raw.data) {
                if (Object.prototype.hasOwnProperty.call(raw.data, i)) {
                    merged[i] = raw.data[i];
                }
            }
        }
        if (raw.custom_data && typeof raw.custom_data === 'object') {
            for (i in raw.custom_data) {
                if (Object.prototype.hasOwnProperty.call(raw.custom_data, i)) {
                    merged[i] = raw.custom_data[i];
                }
            }
        }
        return merged;
    }

    function pickUrl(data) {
        return (
            asString(data.url) ||
            asString(data.click_url) ||
            asString(data.link) ||
            ''
        );
    }

    function pickImageUrl(data) {
        return (
            asString(data.image_url) ||
            asString(data.imageUrl) ||
            asString(data.image) ||
            asString(data.picture) ||
            asString(data.icon) ||
            ''
        );
    }

    function isHttpImageUrl(url) {
        return /^https?:\/\//i.test(url);
    }

    function isDataImageUrl(url) {
        return /^data:image\//i.test(url);
    }

    function resolveImageForNotification(imageUrl) {
        if (!imageUrl) {
            return Promise.resolve({ icon: DEFAULT_PUSH_ICON_DATA_URI, image: '' });
        }
        if (isHttpImageUrl(imageUrl)) {
            return Promise.resolve({ icon: imageUrl, image: imageUrl });
        }
        if (isDataImageUrl(imageUrl)) {
            return fetch(imageUrl)
                .then(function (response) {
                    return response.blob();
                })
                .then(function (blob) {
                    var blobUrl = URL.createObjectURL(blob);
                    return { icon: blobUrl, image: blobUrl };
                })
                .catch(function () {
                    return { icon: DEFAULT_PUSH_ICON_DATA_URI, image: '' };
                });
        }
        return Promise.resolve({ icon: DEFAULT_PUSH_ICON_DATA_URI, image: '' });
    }

    function parsePushPayload(event) {
        var title = 'Уведомление';
        var body = '';
        var raw = {};

        if (event.data) {
            try {
                raw = event.data.json();
            } catch (e) {
                try {
                    body = event.data.text();
                } catch (e2) {
                    body = '';
                }
            }
        }

        var data = flattenPushRoot(raw);
        if (data.title) {
            title = asString(data.title);
        }
        if (data.body) {
            body = asString(data.body);
        }

        return {
            title: title,
            body: body,
            url: pickUrl(data),
            image: pickImageUrl(data),
        };
    }

    function notifyOpenTabs(payload) {
        return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
            list.forEach(function (client) {
                client.postMessage({
                    type: 'PUSH_RECEIVED',
                    title: payload.title,
                    body: payload.body,
                    url: payload.url,
                    image: payload.image,
                });
            });
        });
    }

    function isExternalUrl(url) {
        if (!url) {
            return false;
        }
        try {
            return new URL(url, self.location.origin).origin !== self.location.origin;
        } catch (e) {
            return true;
        }
    }

    var pushConfig = null;

    function urlBase64ToUint8Array(base64String) {
        var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var rawData = atob(base64);
        var outputArray = new Uint8Array(rawData.length);
        var i;
        for (i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    function subscriptionKeys(subscription) {
        var p256dh;
        var authKey;
        if (typeof subscription.toJSON === 'function') {
            var j = subscription.toJSON();
            if (j.keys) {
                p256dh = j.keys.p256dh;
                authKey = j.keys.auth;
            }
        }
        if (!p256dh || !authKey) {
            p256dh = btoa(String.fromCharCode.apply(null, new Uint8Array(subscription.getKey('p256dh'))));
            authKey = btoa(String.fromCharCode.apply(null, new Uint8Array(subscription.getKey('auth'))));
        }
        return { p256dh: p256dh, auth: authKey };
    }

    self.addEventListener('message', function (event) {
        if (event.data && event.data.type === 'push-config') {
            pushConfig = event.data;
        }
    });

    self.addEventListener('pushsubscriptionchange', function (event) {
        if (!pushConfig || !pushConfig.subscribeUrl || !pushConfig.vapidPublicKey || !pushConfig.embedSecret) {
            return;
        }
        event.waitUntil(
            self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(pushConfig.vapidPublicKey),
            }).then(function (subscription) {
                var keys = subscriptionKeys(subscription);
                return fetch(pushConfig.subscribeUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    credentials: 'omit',
                    mode: 'cors',
                    body: JSON.stringify({
                        embed_secret: pushConfig.embedSecret,
                        endpoint: subscription.endpoint,
                        p256dh: keys.p256dh,
                        auth: keys.auth,
                        client_id: pushConfig.clientId || '',
                    }),
                });
            })
        );
    });

    self.addEventListener('push', function (event) {
        var payload = parsePushPayload(event);

        event.waitUntil(
            resolveImageForNotification(payload.image).then(function (visual) {
                var options = {
                    body: payload.body,
                    data: { url: payload.url, image: payload.image },
                    requireInteraction: true,
                    icon: visual.icon,
                };
                if (visual.image) {
                    options.image = visual.image;
                }
                return Promise.all([
                    self.registration.showNotification(payload.title, options),
                    notifyOpenTabs(payload),
                ]);
            })
        );
    });

    self.addEventListener('notificationclick', function (event) {
        event.notification.close();

        var url = '';
        if (event.notification && event.notification.data && event.notification.data.url) {
            url = String(event.notification.data.url).trim();
        }
        if (!url) {
            return;
        }

        event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
                if (isExternalUrl(url)) {
                    if (clients.openWindow) {
                        return clients.openWindow(url);
                    }
                    return;
                }

                for (var i = 0; i < clientList.length; i++) {
                    var client = clientList[i];
                    if ('focus' in client) {
                        if ('navigate' in client) {
                            return client.navigate(url).then(function () {
                                return client.focus();
                            });
                        }
                        return client.focus();
                    }
                }

                if (clients.openWindow) {
                    return clients.openWindow(url);
                }
            })
        );
    });
})();