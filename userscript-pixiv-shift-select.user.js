// ==UserScript==
// @name         userscript-pixiv-shift-select
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Enables shift-clicking to select a range and Ctrl+Shift+Click to deselect a range of bookmarks on Pixiv.
// @author       eatlebugs2
// @match        https://www.pixiv.net/en/users/*/bookmarks/artworks*
// @match        https://www.pixiv.net/users/*/bookmarks/artworks*
// @grant        none
// @run-at       document-idle
// @icon         https://s.pximg.net/common/images/apple-touch-icon.png
// ==/UserScript==

(function() {
    'use strict';

    // --- Script Variables ---
    let lastCheckedIndex = -1;
    let bookmarkItems = []; // Cache of DOM elements for current page's bookmarks
    const listSelector = 'ul.sc-7d21cb21-1'; // CSS selector for the main bookmark list UL
    const itemSelector = 'li.sc-7d21cb21-2'; // CSS selector for individual bookmark LI items
    const checkboxSelector = 'input[type="checkbox"]'; // CSS selector for the checkbox within an item
    let initializationInterval = null; // Interval ID for the initialization loop
    let observer = null; // MutationObserver instance for list changes
    let isInitialized = false; // Flag to prevent multiple initializations
    let previousPageParam = null; // Stores the 'p' URL parameter to detect page changes

    // --- Helper Functions ---

    // Retrieves the React Fiber node from a DOM element
    function getReactFiber(element) {
        if (!element) return null;
        // Common keys for Fiber node. React might change this in future versions.
        const fiberKey = Object.keys(element).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
        return fiberKey ? element[fiberKey] : null;
    }

    // Finds the checkbox DOM element within a bookmark item (LI)
    function findCheckbox(targetElement) {
        const parentLi = targetElement.closest(itemSelector);
        if (parentLi) return parentLi.querySelector(checkboxSelector);
        return null;
    }

    // Updates the cached 'bookmarkItems' array with the current list of LI elements
    function updateBookmarkItems(listElement) {
        if (!listElement) { bookmarkItems = []; return; }
        bookmarkItems = Array.from(listElement.querySelectorAll(itemSelector));
    }

    // Gets the current page number parameter ('p') from the URL
    function getCurrentPageParam() {
        try {
            const params = new URLSearchParams(window.location.search);
            return params.get('p') || '1'; // Default to '1' if 'p' is not present
        } catch (e) {
            // Fallback for rare cases where URLSearchParams might fail
            const match = window.location.href.match(/[\?&]p=(\d+)/);
            return match ? match[1] : '1';
        }
    }

    // --- Main Click Handling Logic ---
    function handleClick(event) {
        const listElement = event.currentTarget; // The UL element the listener is attached to

        // --- Page Change Detection ---
        // Resets selection anchor if the page parameter ('p') has changed
        const currentPageParam = getCurrentPageParam();
        if (previousPageParam === null || previousPageParam !== currentPageParam) {
            lastCheckedIndex = -1;
            bookmarkItems = []; // Clear old items
            updateBookmarkItems(listElement); // Get new items
            previousPageParam = currentPageParam;
        } else {
            // If page hasn't changed, do a quick check if item count matches cache
            const currentItemCountOnPage = listElement.childElementCount;
            if (currentItemCountOnPage !== bookmarkItems.length && bookmarkItems.length > 0) {
                updateBookmarkItems(listElement);
            }
        }

        // Ensure the click originated from within a valid bookmark item
        const clickedLi = event.target.closest(itemSelector);
        if (!clickedLi) return;

        // Check if selection mode is active (e.g., by seeing if checkboxes are visible/interactive)
        const checkbox = findCheckbox(event.target);
        if (!checkbox || checkbox.offsetParent === null) {
            lastCheckedIndex = -1; // Not in selection mode, reset anchor
            return;
        }

        // Get the index of the clicked item in our cached list
        let currentIndex = bookmarkItems.indexOf(clickedLi);
        if (currentIndex === -1) { // Item not found in cache? Try updating and re-finding.
             updateBookmarkItems(listElement);
             currentIndex = bookmarkItems.indexOf(clickedLi);
             if (currentIndex === -1) { // Still not found
                 lastCheckedIndex = -1; return; // Cannot proceed
             }
         }

        // --- Shift-Click Logic for Range Selection/Deselection ---
        if (event.shiftKey && lastCheckedIndex !== -1 && lastCheckedIndex !== currentIndex) {
            // Prevent default browser action for the click on the `currentIndex` element,
            // as the script will manage its state and the range explicitly.
            event.preventDefault();
            event.stopPropagation();

            const start = Math.min(currentIndex, lastCheckedIndex);
            const end = Math.max(currentIndex, lastCheckedIndex);
            const isCtrlShiftClickDeselect = event.ctrlKey; // True if Ctrl key is also pressed

            try {
                for (let i = start; i <= end; i++) {
                    if (i >= bookmarkItems.length || i < 0) continue; // Bounds check
                    const itemLi = bookmarkItems[i];
                    if (itemLi) {
                        const fiber = getReactFiber(itemLi);
                        // Navigate to the relevant props containing selection state and handler
                        if (fiber?.memoizedProps?.children?.props?.selectMode) {
                            const innerProps = fiber.memoizedProps.children.props;
                            const isSelected = innerProps.selectMode.checked;
                            const onChangeHandler = innerProps.selectMode.onChange;

                            if (typeof onChangeHandler === 'function') {
                                if (isCtrlShiftClickDeselect) { // Ctrl+Shift+Click: DESELECT mode
                                    if (isSelected) { // Only act if currently selected
                                        try {
                                            onChangeHandler(); // Call with NO arguments to deselect
                                        } catch (e) {
                                             console.error(`Pixiv Shift-Select: Error calling onChangeHandler() for DESELECT on item ${i}:`, e);
                                        }
                                    }
                                } else { // Normal Shift+Click: SELECT mode
                                    if (!isSelected) { // Only act if currently not selected
                                        try {
                                            const fakeEvent = { target: { checked: true } };
                                            onChangeHandler(fakeEvent); // Call with fake event to select
                                        } catch (e) {
                                             console.error(`Pixiv Shift-Select: Error calling onChangeHandler(fakeEvent) for SELECT on item ${i}:`, e);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } // End of action loop
            } catch (e) {
                 console.error("Pixiv Shift-Select: Error during React Fiber processing loop:", e);
            }

            lastCheckedIndex = currentIndex; // Update anchor to the item just shift-clicked

        } else { // --- Normal Click Logic (or first click setting anchor, or shift-click on anchor itself) ---
            // For normal clicks, default browser action handles the toggle. We just update our anchor.
            lastCheckedIndex = currentIndex;
        }
    }

    // --- Initialization and Observation Logic ---

    // Sets up a MutationObserver to watch for dynamic changes to the bookmark list
    function setupObserver(listElement) {
        if (observer) observer.disconnect(); // Disconnect previous observer if any
        observer = new MutationObserver((mutationsList) => {
            let listChanged = false;
            mutationsList.forEach(mutation => {
                 if (mutation.type === 'childList') { // Check if children were added/removed
                     const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
                     // Check if any changed nodes are actual list items we care about
                     if (changedNodes.some(node => node.nodeType === 1 && node.matches(itemSelector))) {
                         listChanged = true;
                     }
                 }
             });
            if (listChanged) { // If relevant items changed
                updateBookmarkItems(listElement); // Update our cached list
                // Also check for page changes, as list updates can coincide with SPA navigation
                const currentPageParam = getCurrentPageParam();
                if (previousPageParam !== null && previousPageParam !== currentPageParam) {
                    lastCheckedIndex = -1; // Page changed, reset anchor
                    previousPageParam = currentPageParam;
                }
            }
        });
        // Observe the direct children of the list for additions/removals
        observer.observe(listElement, { childList: true });
    }

    // Main initialization function, called once the list element is found
    function initialize() {
        if (isInitialized) return; // Prevent double initialization
        const listElement = document.querySelector(listSelector);
        if (listElement) { // Found the list!
            if (initializationInterval) clearInterval(initializationInterval); // Stop polling
            initializationInterval = null;
            isInitialized = true; // Mark as ready
            previousPageParam = getCurrentPageParam(); // Set initial page parameter
            updateBookmarkItems(listElement); // Perform initial scan for items
            listElement.removeEventListener('click', handleClick); // Remove potential old listener
            listElement.addEventListener('click', handleClick); // Add the main event listener
            setupObserver(listElement); // Watch for dynamic list changes
        }
    }

    // Polls the DOM until the main list element is found, then calls initialize
    function tryInitialize() {
        let attempts = 0;
        const maxAttempts = 40; // Try for 20 seconds (40 * 500ms)
        initializationInterval = setInterval(() => {
            if (isInitialized) { // Stop if already initialized
                clearInterval(initializationInterval);
                return;
            }
            attempts++;
            if (document.querySelector(listSelector)) { // Check if list exists
                initialize(); // Run setup
            } else if (attempts >= maxAttempts) { // Time limit reached?
                clearInterval(initializationInterval); // Stop polling
                // Note: Timeout error message was removed as per user request
            }
        }, 500); // Check every 500ms
    }

    // --- Start the script ---
    if (document.readyState === 'loading') { // Wait for DOM if necessary
        document.addEventListener('DOMContentLoaded', tryInitialize);
    } else { // DOM already ready
        tryInitialize();
    }

})();
