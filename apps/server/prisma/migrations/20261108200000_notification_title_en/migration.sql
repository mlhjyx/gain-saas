-- 通知英文标题（M2 P6：en 界面的站内通知不再回落中文；历史行保持 NULL）
ALTER TABLE "notification" ADD COLUMN "title_en" TEXT;
