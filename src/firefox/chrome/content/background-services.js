/*
 * Copyright Adam Pritchard 2013
 * MIT License : http://adampritchard.mit-license.org/
 */

/*
 * This file is loaded as a background script in the main window -- even in
 * Thunderbird, where the other background script is only loaded for compose
 * windows.
 * This provides services for supplying access to preferences and other
 * background-only functions.
 *
 * From: https://developer.mozilla.org/en-US/docs/Code_snippets/Interaction_between_privileged_and_non-privileged_pages#Chromium-like_messaging.3A_json_request_with_json_callback
 *
 * Note that the stored prefs are returned raw (well, after being JSON parsed).
 * No additional processing is done, like filling in default values.
 */


(function() {
"use strict";
/*global Components:false, AddonManager:false, markdown_here:false*/
/*jshint devel:true*/

var scriptLoader, imports = {};

// See comment in ff-overlay.js for info about module loading.
scriptLoader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"]
                             .getService(Components.interfaces.mozIJSSubScriptLoader);

scriptLoader.loadSubScript('resource://markdown_here_common/highlightjs/highlight.js');
imports.hljs = window.hljs;
scriptLoader.loadSubScript('resource://markdown_here_common/utils.js');
imports.Utils = window.Utils;
scriptLoader.loadSubScript('resource://markdown_here_common/common-logic.js');
imports.CommonLogic = window.CommonLogic;
scriptLoader.loadSubScript('resource://markdown_here_common/marked.js');
imports.marked = window.marked;
scriptLoader.loadSubScript('resource://markdown_here_common/markdown-render.js');
imports.MarkdownRender = window.MarkdownRender;
scriptLoader.loadSubScript('resource://markdown_here_common/options-store.js');
imports.OptionsStore = window.OptionsStore;


/*
 * Set up the background request listeners
 */

document.addEventListener(imports.Utils.PRIVILEGED_REQUEST_EVENT_NAME, function(event) {
  var node, doc, request, responseEventName, responseCallback, asyncResponseCallback;

  node = event.target;
  if (!node || node.nodeType != node.TEXT_NODE) {
    return;
  }

  doc = node.ownerDocument;
  request = node.nodeValue ? JSON.parse(node.nodeValue) : null;
  responseEventName = request.responseEventName;

  responseCallback = function(response) {
    responseCallback.prototype.gotCalled = true;

    node.nodeValue = JSON.stringify(null);
    if (response) {
      node.nodeValue = JSON.stringify(response);
    }

    var event = doc.createEvent('HTMLEvents');
    event.initEvent(responseEventName, true, false);
    return node.dispatchEvent(event);
  };

  // NOTE: Request handlers *must* set this to true if they are going to call
  // the response callback asynchronously.
  asyncResponseCallback = false;

  if (request.action === 'render') {
    imports.OptionsStore.get(function(prefs) {
      responseCallback({
        html: imports.MarkdownRender.markdownRender(
          request.mdText,
          prefs,
          imports.marked,
          imports.hljs),
        css: (prefs['main-css'] + prefs['syntax-css'])
      });
    });
    asyncResponseCallback = true;
  }
  else if (request.action === 'open-tab') {
    asyncResponseCallback = false;
    openTab(request.url);
  }
  else if (request.action === 'prefs-access') {
    asyncResponseCallback = false;
    responseCallback(prefsAccessRequestHandler(request));
  }
  else if (request.action === 'get-forgot-to-render-prompt') {
    asyncResponseCallback = true;
    imports.CommonLogic.getForgotToRenderPromptContent(function(html) {
      responseCallback({html: html});
    });
  }
  else if (request.action === 'get-string-bundle') {
    asyncResponseCallback = false;
    responseCallback(getStringBundleHandler());
  }
  else if (request.action === 'webext-upgrade') {
    asyncResponseCallback = true;

    // The options page is requesting that we perform the XUL-to-WebExtensions
    // upgrade. This involves installing the new extension and then uninstall
    // the old one (which is the one in which this code is running).

    // TODO: Determine the final URL, after review of the WebExt. Try to find one
    // that points to the "latest", rather than a specific build.
    var webExtURL = 'https://addons.mozilla.org/firefox/downloads/file/654719/markdown_here-2.13.1-an+fx-windows.xpi';

    // Get the new extension installer.
    AddonManager.getInstallForURL(
      webExtURL,
      function getInstallForURLCallback(install) {
        // We have the new installer, now get the currently installed XUL extension.
        AddonManager.getAddonByID(
          'markdown-here@adam.pritchard',
          function getAddonByIDCallback(addon) {
            // Now we'll install the new WebExt extension before proceeding to
            // uninstall the XUL extension.

            // If the WebExt install fails, we're not going to uninstall.
            function installFailed() {
              var prompts = Components.classes['@mozilla.org/embedcomp/prompt-service;1']
                                      .getService(Components.interfaces.nsIPromptService);
              prompts.alert(null, 'Markdown Here', "Upgrade install failed.\n\nReload this page to try again.\n\nIf it keeps failing, you'll need to upgrade manually.");
              responseCallback();
            }

            var installListener = {
              onNewInstall: function() {}, onDownloadStarted: function() {},
              onDownloadProgress: function() {}, onDownloadEnded: function() {},
              onDownloadCancelled: function() {}, onInstallStarted: function() {},
              onInstallCancelled: function() {}, onExternalInstall: function() {},

              onDownloadFailed: installFailed, onInstallFailed: installFailed,

              onInstallEnded: function() {
                // WebExt install succeeded.

                // Close the XUL-Options tab, so that it doesn't re-open when
                // the session is restored after browser restart.
                closeCurrentTab();

                // Uninstall the XUL extension. This is a synchronous call.
                addon.uninstall();

                responseCallback();

                // Restart the browser. This is needed to fully uninstall,
                // including getting rid of the toolbar button.
                var appStartup = Components.classes['@mozilla.org/toolkit/app-startup;1']
                 .getService(Components.interfaces.nsIAppStartup);
                appStartup.quit(appStartup.eForceQuit | appStartup.eRestart);
              }
            };

            // Start listening for install completion before starting, to avoid
            // a race condition.
            install.addListener(installListener);

            // Begin the download+install of the WebExt extension.
            install.install();
          });
      },
      'application/x-xpinstall');
  }
  else if (request.action === 'test-request') {
    asyncResponseCallback = false;
    responseCallback('test-request-good');
  }
  else {
    imports.Utils.consoleLog('Markdown Here background script request handler: unmatched request action: ' + request.action);
    throw new Error('unmatched request action: ' + request.action);
  }

  // If the specific request handler hasn't indicated that it'll respond
  // asynchronously, and the responseCallback hasn't already been called,
  // then we need to make sure it happens now.
  if (!asyncResponseCallback && !responseCallback.prototype.gotCalled) {
    responseCallback(undefined);
  }
},
false, // useCapture
true); // wantsUntrusted -- needed for communication with content scripts


// Access the actual Firefox/Thunderbird stored prefs.
function prefsAccessRequestHandler(request) {
  var extPrefsBranch, supportString, prefKeys, prefsObj, i;

  extPrefsBranch = Components.classes['@mozilla.org/preferences-service;1']
                             .getService(Components.interfaces.nsIPrefService)
                             .getBranch('extensions.markdown-here.');
  supportString = Components.classes["@mozilla.org/supports-string;1"]
                            .createInstance(Components.interfaces.nsISupportsString);

  if (request.verb === 'get') {
    prefKeys = extPrefsBranch.getChildList('');
    prefsObj = {};

    for (i = 0; i < prefKeys.length; i++) {
      // All of our legitimate prefs should be strings, but issue #237 suggests
      // that things may sometimes get into a bad state. We will check and delete
      // and prefs that aren't strings.
      // https://github.com/adam-p/markdown-here/issues/237
      if (extPrefsBranch.getPrefType(prefKeys[i]) !== extPrefsBranch.PREF_STRING) {
        extPrefsBranch.clearUserPref(prefKeys[i]);
        continue;
      }

      try {
        prefsObj[prefKeys[i]] = JSON.parse(
                                  extPrefsBranch.getComplexValue(
                                    prefKeys[i],
                                    Components.interfaces.nsISupportsString).data);
      }
      catch(e) {
        // Null values and empty strings will result in JSON exceptions
        prefsObj[prefKeys[i]] = null;
      }
    }

    return prefsObj;
  }
  else if (request.verb === 'set') {
    for (var key in request.obj) {
      supportString.data = JSON.stringify(request.obj[key]);
      extPrefsBranch.setComplexValue(
        key,
        Components.interfaces.nsISupportsString,
        supportString);
    }

    return;
  }
  else if (request.verb === 'clear') {
    if (typeof(request.obj) === 'string') {
      request.obj = [request.obj];
    }

    for (i = 0; i < request.obj.length; i++) {
      extPrefsBranch.clearUserPref(request.obj[i]);
    }

    return;
  }

  return alert('Error: no matching prefs access verb');
}


function getStringBundleHandler() {
  return imports.Utils.getMozStringBundle();
}


/*
 * In order to check if this is a new version, etc., we need some code that runs
 * when the application starts. In the case of Thunderbird, our regular overlay
 * only loads when a new message is opened, so we're going to hijack this
 * overlay code to add some version checks and startup code.
 */
try {
    // Firefox 4 and later; Mozilla 2 and later
    Components.utils.import("resource://gre/modules/AddonManager.jsm");
    AddonManager.getAddonByID("markdown-here@adam.pritchard", function(addon) {
        updateHandler(addon.version);
  });
}
catch (ex) {
    // Firefox 3.6 and before; Mozilla 1.9.2 and before
    var em = Components.classes["@mozilla.org/extensions/manager;1"]
             .getService(Components.interfaces.nsIExtensionManager);
    var addon = em.getItemForID("markdown-here@adam.pritchard");
    updateHandler(addon.version);
}

function updateHandler(currVer) {
  var prefService = Components.classes['@mozilla.org/preferences-service;1']
                              .getService(Components.interfaces.nsIPrefService);
  var extPrefsBranch = prefService.getBranch('extensions.markdown-here.');
  var extSyncBranch = prefService.getBranch('services.sync.prefs.sync.extensions.markdown-here.');
  var supportString = Components.classes["@mozilla.org/supports-string;1"]
                                .createInstance(Components.interfaces.nsISupportsString);

  var lastVersion = '';
  try {
    lastVersion = JSON.parse(
                    extPrefsBranch.getComplexValue(
                      'last-version',
                      Components.interfaces.nsISupportsString).data);
  }
  catch (ex) {
  }

  // The presence of this pref indicates that it's not the first run.
  var localFirstRun = !extPrefsBranch.prefHasUserValue('local-first-run');

  supportString.data = JSON.stringify(false);
  extPrefsBranch.setComplexValue(
    'local-first-run',
    Components.interfaces.nsISupportsString,
    supportString);

  if (currVer !== lastVersion) {
    supportString.data = JSON.stringify(currVer);
    extPrefsBranch.setComplexValue(
      'last-version',
      Components.interfaces.nsISupportsString,
      supportString);

    // Set the preference sync flags while we're at it.

    // First our user-level prefs
    for (var key in imports.OptionsStore.defaults) {
      extSyncBranch.setBoolPref(key, true);
    }

    // last-version isn't a user pref but should also be synched.
    extSyncBranch.setBoolPref('last-version', true);

    // local-first-run should not be synched, as it only applies locally.
    extSyncBranch.setBoolPref('local-first-run', false);

    // This is a bit dirty. If we open the new tab immediately, it will get
    // overwritten when session restore starts creating tabs. So we'll wait a
    // couple of seconds after the last tab is restored to open ours.
    // But we'll also have to make sure we handle the case that no tabs are
    // being restored.

    var timeoutID = null;

    var tabRestored = function() {
      var postTabRestoredOptionsOpen = function() {
        document.removeEventListener('SSTabRestored', tabRestored);

        var optionsURL = 'resource://markdown_here_common/options.html';
        if (lastVersion) {
          // If this is an upgrade, show the changelist
          optionsURL += '?prevVer=' + lastVersion;
        }

        // If `markdown_here` is available, then we're going to assume we can
        // use it to show the notification. (I.e., it's presence is our
        // capability check.)
        var canShowUpgradeNotification = typeof(markdown_here) !== 'undefined';

        if (imports.Utils.xulToWebExtUpgradeRequired()) {
          // The user needs to upgrade from XUL to WebExt, so show the options page.
          openTab(optionsURL);
        }
        else if (lastVersion && canShowUpgradeNotification) {
          // If this is an upgrade, show the upgrade notification
          markdown_here.showUpgradeNotification(optionsURL, openTab);
        }
        else {
          // If this is a brand new install or we can't handle upgrade notifications,
          // show our options page.
          openTab(optionsURL);
        }
      };

      clearTimeout(timeoutID);
      timeoutID = setTimeout(postTabRestoredOptionsOpen, 2000);
    };
    timeoutID = setTimeout(tabRestored, 1);
    document.addEventListener('SSTabRestored', tabRestored, false);
  }

  if (localFirstRun) {
    installButton('nav-bar', 'toolbarButton-markdown_here');

    // Note that we can't add the same button to more than one toolbar.
    // If we wanted to add the button to the addon toolbar, we'd use this
    // line.
    // The 'addon-bar' is available since Firefox 4
    //installButton('addon-bar', 'toolbarButton-markdown_here');
  }
}

// From: https://developer.mozilla.org/en-US/docs/Code_snippets/Toolbar#Adding_button_by_default
/**
 * Installs the toolbar button with the given ID into the given
 * toolbar, if it is not already present in the document.
 *
 * @param {string} toolbarId The ID of the toolbar to install to.
 * @param {string} id The ID of the button to install.
 * @param {string} afterId The ID of the element to insert after. @optional
 */
function installButton(toolbarId, id, afterId) {
  if (!document.getElementById(id)) {
    var toolbar, elem;

    toolbar = document.getElementById(toolbarId);

    if (!toolbar) {
      return;
    }

    // If no afterId is given, then append the item to the toolbar
    var before = null;
    if (afterId) {
      elem = document.getElementById(afterId);
      if (elem && elem.parentNode == toolbar) {
        before = elem.nextElementSibling;
      }
    }

    toolbar.insertItem(id, before);
    toolbar.setAttribute('currentset', toolbar.currentSet);
    document.persist(toolbar.id, 'currentset');

    if (toolbarId == 'addon-bar') {
      toolbar.collapsed = false;
    }
  }
}


/*
 * Helper to open tabs, mostly for Thunderbird and friends.
 */
function openTab(url) {
  var windowMediator = Components.classes['@mozilla.org/appshell/window-mediator;1']
                                 .getService(Components.interfaces.nsIWindowMediator);

  if (navigator.userAgent.indexOf('Thunderbird') >= 0 ||
      navigator.userAgent.indexOf('Icedove') >= 0) {
      windowMediator.getMostRecentWindow('mail:3pane')
                    .document.getElementById('tabmail')
                    .openTab('contentTab', {contentPage: url});
  }
  else if (navigator.userAgent.indexOf('Postbox') >= 0) {
      /* Haven't yet figured out how to open a tab in Postbox */
  }
  else {
      var win = windowMediator.getMostRecentWindow('navigator:browser');
      win.gBrowser.selectedTab = win.gBrowser.addTab(url);
  }
}

function closeCurrentTab() {
  var windowMediator = Components.classes['@mozilla.org/appshell/window-mediator;1']
                                 .getService(Components.interfaces.nsIWindowMediator);

  if (navigator.userAgent.indexOf('Thunderbird') >= 0 ||
      navigator.userAgent.indexOf('Icedove') >= 0) {
      windowMediator.getMostRecentWindow('mail:3pane')
                    .document.getElementById('tabmail')
                    .removeCurrentTab();
  }
  else if (navigator.userAgent.indexOf('Postbox') >= 0) {
      /* Haven't yet figured out how to open a tab in Postbox */
  }
  else {
      var win = windowMediator.getMostRecentWindow('navigator:browser');
      win.gBrowser.selectedTab = win.gBrowser.removeCurrentTab();
  }
}
})();
