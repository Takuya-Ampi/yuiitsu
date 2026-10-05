-- テストはワーカーごとに autoapi_test_w<N> データベースを作る
GRANT ALL PRIVILEGES ON `autoapi\_test%`.* TO 'autoapi'@'%';
GRANT ALL PRIVILEGES ON `autoapi\_test`.* TO 'autoapi'@'%';
FLUSH PRIVILEGES;
