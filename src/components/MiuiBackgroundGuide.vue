<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      @click.self="dismiss"
    >
      <div class="w-full max-w-md rounded-2xl bg-white dark:bg-dark-surface shadow-2xl overflow-hidden">
        <div class="px-6 py-5 border-b border-gray-200 dark:border-dark-gray">
          <h2 class="text-lg font-semibold text-ios-dark-gray dark:text-dark-text">
            {{ languageStore.t('miuiGuide.title') }}
          </h2>
          <p class="text-sm text-ios-gray dark:text-dark-secondary mt-1">
            {{ languageStore.t('miuiGuide.subtitle') }}
          </p>
        </div>

        <div class="px-6 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          <p class="text-sm text-ios-dark-gray dark:text-dark-text">
            {{ languageStore.t('miuiGuide.intro') }}
          </p>
          <ol class="list-decimal list-inside space-y-2 text-sm text-ios-dark-gray dark:text-dark-text">
            <li>{{ languageStore.t('miuiGuide.step1') }}</li>
            <li>{{ languageStore.t('miuiGuide.step2') }}</li>
            <li>{{ languageStore.t('miuiGuide.step3') }}</li>
            <li>{{ languageStore.t('miuiGuide.step4') }}</li>
          </ol>
          <p class="text-xs text-ios-gray dark:text-dark-secondary mt-2">
            {{ languageStore.t('miuiGuide.footer') }}
          </p>
        </div>

        <div class="px-6 py-4 flex items-center justify-between gap-3 border-t border-gray-200 dark:border-dark-gray">
          <label class="flex items-center gap-2 text-sm text-ios-gray dark:text-dark-secondary">
            <input v-model="dontShowAgain" type="checkbox" class="rounded" />
            {{ languageStore.t('miuiGuide.dontShowAgain') }}
          </label>
          <button
            class="px-4 py-2 rounded-ios bg-ios-blue text-white text-sm hover:opacity-90 transition-opacity"
            @click="dismiss"
          >
            {{ languageStore.t('miuiGuide.gotIt') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { useLanguageStore } from '@/stores/language'

const languageStore = useLanguageStore()
const visible = ref(false)
const dontShowAgain = ref(true)

const STORAGE_KEY = 'globalRadio.miuiGuideDismissed'

const detectXiaomi = async (): Promise<boolean> => {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false
  try {
    const info = await Device.getInfo()
    const manufacturer = (info.manufacturer || '').toLowerCase()
    const model = (info.model || '').toLowerCase()
    return (
      manufacturer.includes('xiaomi') ||
      manufacturer.includes('redmi') ||
      model.includes('mi ') ||
      model.includes('redmi') ||
      model.includes('poco')
    )
  } catch {
    return false
  }
}

const dismiss = () => {
  if (dontShowAgain.value) {
    try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* no-op */ }
  }
  visible.value = false
}

onMounted(async () => {
  try {
    if (localStorage.getItem(STORAGE_KEY) === '1') return
  } catch { /* no-op */ }
  if (await detectXiaomi()) {
    setTimeout(() => { visible.value = true }, 1500)
  }
})
</script>
