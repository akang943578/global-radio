<template>
  <div class="favorites-page min-h-screen bg-ios-light-gray dark:bg-dark-bg pb-20">
    <!-- 移动端标题栏 -->
    <div class="mobile:block desktop:hidden sticky top-0 z-10 glass-effect border-b border-gray-200 dark:border-dark-gray px-4 py-3">
      <div class="flex items-start justify-between min-h-[44px]">
        <h1 class="text-lg sm:text-xl md:text-2xl font-bold text-ios-dark-gray dark:text-dark-text leading-tight max-w-[65%] break-words hyphens-auto flex-shrink-1 whitespace-normal">{{ t('nav.favorites') }}</h1>
        <div class="flex items-center gap-2 flex-shrink-0">
          <!-- 视图模式切换 -->
          <div v-if="playerStore.favorites.length > 0" class="flex items-center bg-gray-100 dark:bg-dark-gray rounded-ios p-0.5">
            <button
              @click="viewMode = 'list'"
              :class="[
                'p-1.5 rounded-md transition-all flex items-center justify-center',
                viewMode === 'list' 
                  ? 'bg-white dark:bg-dark-surface text-ios-blue shadow-sm' 
                  : 'text-ios-gray dark:text-dark-secondary hover:text-ios-dark-gray dark:hover:text-dark-text'
              ]"
            >
              <Bars3Icon class="w-4 h-4" />
            </button>
            <button
              @click="viewMode = 'grid'"
              :class="[
                'p-1.5 rounded-md transition-all flex items-center justify-center',
                viewMode === 'grid' 
                  ? 'bg-white dark:bg-dark-surface text-ios-blue shadow-sm' 
                  : 'text-ios-gray dark:text-dark-secondary hover:text-ios-dark-gray dark:hover:text-dark-text'
              ]"
            >
              <Squares2X2Icon class="w-4 h-4" />
            </button>
          </div>
          <ThemeToggle />
          <button
            v-if="playerStore.favorites.length > 0"
            @click="showClearDialog = true"
            :class="[
              'text-ios-red font-medium hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1 rounded-ios transition-colors',
              // 针对长文本语言使用较小字体和允许换行
              ['es', 'fr', 'de', 'ja', 'ko', 'ru', 'pt', 'it', 'th', 'vi'].includes(currentLanguage) 
                ? 'text-xs leading-tight text-center min-w-0 max-w-[80px]' 
                : 'text-sm whitespace-nowrap'
            ]"
            :style="[
              ['es', 'fr', 'de', 'ja', 'ko', 'ru', 'pt', 'it', 'th', 'vi'].includes(currentLanguage) 
                ? { wordBreak: 'break-word', whiteSpace: 'normal', lineHeight: '1.2' } 
                : {}
            ]"
          >
            {{ t('favorites.clearAll') }}
          </button>
        </div>
      </div>
    </div>
    
    <!-- PC端标题栏 -->
    <div class="mobile:hidden desktop:block px-6 py-4 border-b border-gray-200 dark:border-dark-gray">
      <div class="flex items-center justify-between">
        <h1 class="text-3xl font-bold text-ios-dark-gray dark:text-dark-text">{{ t('favorites.title') }}</h1>
        <div class="flex items-center gap-3">
          <!-- 视图模式切换 -->
          <div v-if="playerStore.favorites.length > 0" class="flex items-center bg-gray-100 dark:bg-dark-gray rounded-ios p-0.5">
            <button
              @click="viewMode = 'list'"
              :class="[
                'p-2 rounded-md transition-all',
                viewMode === 'list' 
                  ? 'bg-white dark:bg-dark-surface text-ios-blue shadow-sm' 
                  : 'text-ios-gray dark:text-dark-secondary hover:text-ios-dark-gray dark:hover:text-dark-text'
              ]"
            >
              <Bars3Icon class="w-5 h-5" />
            </button>
            <button
              @click="viewMode = 'grid'"
              :class="[
                'p-2 rounded-md transition-all',
                viewMode === 'grid' 
                  ? 'bg-white dark:bg-dark-surface text-ios-blue shadow-sm' 
                  : 'text-ios-gray dark:text-dark-secondary hover:text-ios-dark-gray dark:hover:text-dark-text'
              ]"
            >
              <Squares2X2Icon class="w-5 h-5" />
            </button>
          </div>
          <button
            v-if="playerStore.favorites.length > 0"
            @click="showClearDialog = true"
            class="text-ios-red text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20 px-4 py-2 rounded-ios transition-colors"
          >
            {{ t('favorites.clearAll') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 收藏列表 -->
    <div v-if="playerStore.favorites.length > 0" class="container-responsive p-4">
      <!-- v2.0.23: 一次性拖拽提示 -->
      <div
        v-if="showReorderHint"
        class="mb-3 px-3 py-2 rounded-ios bg-ios-blue/10 dark:bg-ios-blue/20 border border-ios-blue/20 dark:border-ios-blue/30 flex items-center justify-between gap-3 text-xs sm:text-sm"
      >
        <div class="flex items-center gap-2 text-ios-blue dark:text-ios-blue min-w-0">
          <Bars3Icon class="w-4 h-4 flex-shrink-0" />
          <span class="truncate">{{ t('favorites.reorderHint') }}</span>
        </div>
        <button
          @click="dismissReorderHint"
          class="flex-shrink-0 px-2 py-0.5 rounded-md text-ios-blue dark:text-ios-blue hover:bg-ios-blue/20 transition-colors"
        >
          {{ t('favorites.reorderHintDismiss') }}
        </button>
      </div>

      <!--
        v2.0.25: long-press anywhere on the card to drag. No more
        dedicated handle. Touch-only delay is OFF so mouse drag also
        works (helps QA in emulator / desktop). force-fallback flips
        SortableJS off the HTML5 native Drag-and-Drop API and onto its
        own pointer-event implementation, which is the only one that
        works reliably inside Android WebView / Chromium on MIUI.
        filter=".no-drag-trigger" excludes the play / favorite / share
        buttons inside each card so tapping them still fires their own
        click handler instead of starting a drag.
      -->
      <VueDraggable
        v-if="viewMode === 'list'"
        v-model="draggableModel"
        :animation="200"
        :delay="500"
        :delay-on-touch-only="false"
        :touch-start-threshold="5"
        :force-fallback="true"
        :fallback-tolerance="3"
        :prevent-on-filter="false"
        filter=".no-drag-trigger,button"
        ghost-class="dragging-ghost"
        chosen-class="dragging-chosen"
        class="space-y-3"
        @end="onReorderEnd"
      >
        <StationCard
          v-for="station in draggableModel"
          :key="'list-' + station.stationuuid"
          :station="convertToRadioStation(station)"
          @play="playStation"
          @favorite="removeFavorite"
          @share="showShareModal"
        />
      </VueDraggable>

      <!-- 网格视图 — 长按拖动；同样设置 -->
      <VueDraggable
        v-else
        v-model="draggableModel"
        :animation="200"
        :delay="500"
        :delay-on-touch-only="false"
        :touch-start-threshold="5"
        :force-fallback="true"
        :fallback-tolerance="3"
        :prevent-on-filter="false"
        filter=".no-drag-trigger,button"
        ghost-class="dragging-ghost"
        chosen-class="dragging-chosen"
        class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"
        @end="onReorderEnd"
      >
        <StationGridCard
          v-for="station in draggableModel"
          :key="'grid-' + station.stationuuid"
          :station="convertToRadioStation(station)"
          @play="playStation"
          @favorite="removeFavorite"
          @share="showShareModal"
        />
      </VueDraggable>
    </div>

    <!-- 空状态 -->
    <div v-else class="flex flex-col items-center justify-center min-h-[60vh] px-4">
      <div class="text-center">
        <HeartIcon class="w-16 h-16 text-ios-light-gray dark:text-dark-secondary mx-auto mb-4" />
        <h3 class="text-lg font-medium text-ios-dark-gray dark:text-dark-text mb-2">{{ t('favorites.empty') }}</h3>
        <p class="text-ios-gray dark:text-dark-secondary mb-6">{{ t('favorites.emptyHint') }}</p>
        <div class="space-y-3">
          <router-link
            to="/"
            class="ios-button bg-ios-blue text-white px-6 py-3 rounded-ios font-medium inline-block"
          >
            {{ t('favorites.browseStations') }}
          </router-link>
          <router-link
            to="/search"
            class="ios-button bg-white dark:bg-dark-surface text-ios-blue dark:text-ios-blue border border-ios-blue dark:border-ios-blue px-6 py-3 rounded-ios font-medium inline-block ml-3"
          >
            {{ t('favorites.searchStations') }}
          </router-link>
        </div>
      </div>
    </div>

    <!-- 清空确认对话框 -->
    <div
      v-if="showClearDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      @click="showClearDialog = false"
    >
      <div
        class="bg-white dark:bg-dark-surface rounded-ios p-6 mx-4 max-w-sm w-full"
        @click.stop
      >
        <h3 class="text-lg font-semibold text-ios-dark-gray dark:text-dark-text mb-2">{{ t('favorites.clearConfirmTitle') }}</h3>
        <p class="text-ios-gray dark:text-dark-secondary mb-6">{{ t('favorites.clearConfirmMessage') }}</p>
        <div class="flex gap-3">
          <button
            @click="showClearDialog = false"
            class="flex-1 ios-button bg-gray-100 dark:bg-dark-gray text-ios-dark-gray dark:text-dark-text py-3 rounded-ios font-medium"
          >
            {{ t('favorites.cancel') }}
          </button>
          <button
            @click="clearAllFavorites"
            class="flex-1 ios-button bg-ios-red text-white py-3 rounded-ios font-medium"
          >
            {{ t('favorites.clear') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 分享模态框 -->
    <ShareModal
      :visible="showShareModalVisible"
      :station="shareStation"
      @close="closeShareModal"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import { usePlayerStore } from '@/stores/player'
import { useLanguageStore } from '@/stores/language'
import type { RadioStation, FavoriteStation } from '@/types/radio'

import StationCard from '@/components/StationCard.vue'
import StationGridCard from '@/components/StationGridCard.vue'
import ShareModal from '@/components/ShareModal.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import { HeartIcon, Bars3Icon, Squares2X2Icon } from '@heroicons/vue/24/outline'

const playerStore = usePlayerStore()
const languageStore = useLanguageStore()
const { t } = languageStore
const currentLanguage = languageStore.currentLanguage
const showClearDialog = ref(false)
const viewMode = ref<'list' | 'grid'>('list')
const showShareModalVisible = ref(false)
const shareStation = ref<RadioStation | null>(null)

// v2.0.23: drag-and-drop reorder. We bind VueDraggable to a local mirror
// (`draggableModel`) instead of `playerStore.favorites` directly, because
// the library mutates the bound array in place during drag, which would
// trigger every `watchEffect` on favorites + the auto-save in the store
// on every frame. We sync external changes (add/remove from elsewhere)
// into the mirror via a watcher; on drag end we push the mirror back
// into the store via `reorderFavorites` (which internally checks for
// no-op reorders and avoids spurious sync events).
const draggableModel = ref<FavoriteStation[]>([...playerStore.favorites])
watch(
  () => playerStore.favorites,
  (next) => {
    // External update (favorite add/remove from another view, server pull,
    // etc). Only resync when the SET of stations differs — re-syncing on
    // pure reorder events would override the user's drag mid-gesture.
    const a = next.map(f => f.stationuuid).slice().sort().join(',')
    const b = draggableModel.value.map(f => f.stationuuid).slice().sort().join(',')
    if (a !== b) {
      draggableModel.value = [...next]
    }
  },
  { deep: true }
)

const onReorderEnd = () => {
  playerStore.reorderFavorites(draggableModel.value.slice())
}

// One-time hint banner. Persisted to localStorage so we don't pester the
// user every time they open the page. Shown only when there are >=2
// favorites (otherwise drag is meaningless).
// v2.0.25: bump key so users who saw the old "use the handle on the left"
// hint see the new "long-press anywhere to drag" hint exactly once.
const REORDER_HINT_KEY = 'favorites-reorder-hint-seen-v225'
const reorderHintSeen = ref<boolean>(false)
onMounted(() => {
  try {
    reorderHintSeen.value = localStorage.getItem(REORDER_HINT_KEY) === '1'
  } catch {
    reorderHintSeen.value = false
  }
})
const showReorderHint = computed(
  () => !reorderHintSeen.value && playerStore.favorites.length >= 2
)
const dismissReorderHint = () => {
  reorderHintSeen.value = true
  try {
    localStorage.setItem(REORDER_HINT_KEY, '1')
  } catch {
    /* private mode / quota — fall through, just don't crash. */
  }
}

const playStation = (station: RadioStation) => {
  playerStore.playStation(station)
}

const removeFavorite = (station: RadioStation) => {
  playerStore.removeFavorite(station.stationuuid)
}

const clearAllFavorites = () => {
  playerStore.clearFavorites()
  showClearDialog.value = false
}

const showShareModal = (station: RadioStation) => {
  shareStation.value = station
  showShareModalVisible.value = true
}

const closeShareModal = () => {
  showShareModalVisible.value = false
  shareStation.value = null
}

// 将FavoriteStation转换为RadioStation
const convertToRadioStation = (favorite: FavoriteStation): RadioStation => {
  return {
    stationuuid: favorite.stationuuid,
    name: favorite.name,
    url: favorite.url,
    url_resolved: favorite.url,
    homepage: '',
    favicon: favorite.favicon,
    tags: '',
    country: favorite.country,
    countrycode: '',
    state: '',
    language: '',
    languagecodes: '',
    votes: 0,
    lastchangetime: '',
    lastchangetime_iso8601: '',
    codec: '',
    bitrate: 0,
    hls: 0,
    lastcheckok: 1,
    lastchecktime: '',
    lastchecktime_iso8601: '',
    lastcheckoktime: '',
    lastcheckoktime_iso8601: '',
    lastlocalchecktime: '',
    lastlocalchecktime_iso8601: '',
    clicktimestamp: '',
    clicktimestamp_iso8601: '',
    clickcount: 0,
    clicktrend: 0,
    ssl_error: 0,
    geo_lat: 0,
    geo_long: 0,
    has_extended_info: false
  }
}
</script>

<style scoped>
/*
  v2.0.25: drag-and-drop visuals for SortableJS forceFallback mode.

  - touch-action:none on the draggable items so the WebView doesn't
    interpret the long-press as a text-selection / scroll gesture and
    cancel the pointermove stream Sortable needs.
  - user-select:none so text inside the card doesn't get selected during
    the 500ms long-press wait.
  - We scope to direct children of the draggable lists so the rest of
    the page (sticky header, hint banner, dialogs) keeps normal touch
    behavior.
*/
.favorites-page :deep(.sortable-drag),
.favorites-page :deep(.sortable-ghost),
.favorites-page :deep(.sortable-fallback) {
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}

.favorites-page :deep(.dragging-ghost) {
  opacity: 0.35;
}

.favorites-page :deep(.dragging-chosen) {
  /* Subtle ring + lift; .ios-card already has rounded corners and shadow */
  outline: 2px solid #007AFF;
  outline-offset: -2px;
  box-shadow: 0 8px 20px rgba(0, 122, 255, 0.25);
  transition: box-shadow 120ms ease-out;
}
</style>