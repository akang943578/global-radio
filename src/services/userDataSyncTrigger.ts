let pushHandler: (() => void) | null = null
let immediatePushHandler: (() => void) | null = null

// v2.0.24: split into scheduled (debounced) and immediate variants. The
// immediate path is used for destructive operations like
// `removeFavorite` / `clearFavorites` so that a deletion can never be
// lost to a closed-tab-before-debounce-fires race.
export function registerUserDataPushHandler(
  handler: () => void,
  immediate?: () => void
) {
  pushHandler = handler
  if (immediate) {
    immediatePushHandler = immediate
  }
}

export function scheduleUserDataPush() {
  pushHandler?.()
}

export function pushUserDataNow() {
  // Falls back to the debounced handler if no immediate one has been
  // registered yet (e.g. during early-boot before useUserSyncStore is
  // initialized) so we never silently drop a sync request.
  if (immediatePushHandler) {
    immediatePushHandler()
  } else {
    pushHandler?.()
  }
}
