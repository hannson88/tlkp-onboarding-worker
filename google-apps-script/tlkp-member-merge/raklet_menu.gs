function rakletSyncAndMerge() {
  const props = PropertiesService.getScriptProperties();

  props.setProperty("raklet_merge_after_sync", "true");

  rakletStartSync();

  SpreadsheetApp.getUi().alert(
    "Raklet sync started. Merge will run automatically after completion."
  );
}

function rakletSyncApiTestMenu() {
  const props = PropertiesService.getScriptProperties();

  props.deleteProperty("raklet_merge_after_sync");

  rakletStartSyncApiTest();

  SpreadsheetApp.getUi().alert(
    'Raklet API test sync started. Data will be written to "raklet_api_test".'
  );
}
