<script lang="ts" setup>
/**
 * 认证布局：直通容器。登录/注册页(PRD §14 + GainOS 品牌规范)自持整屏,
 * 不再使用 vben AuthPageLayout 的固定品牌面板。
 */
</script>

<template>
  <div class="gainos-auth-shell">
    <RouterView />
  </div>
</template>

<style scoped>
.gainos-auth-shell {
  min-height: 100vh;
  background: #f7f8fa;
  /* 认证页独占视口：禁止外层产生第二条滚动条 */
  overflow-x: hidden;
}
</style>
