function getRakletToken() {
  const props = PropertiesService.getScriptProperties();

  const username = props.getProperty("RAKLET_USERNAME");
  const password = props.getProperty("RAKLET_PASSWORD");

  if (!username || !password) {
    throw new Error("Missing Raklet credentials in Script Properties");
  }

  const response = UrlFetchApp.fetch("https://api.raklet.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    muteHttpExceptions: true,
    payload: {
      grant_type: "password",
      username: username.trim(),
      password: password
    }
  });

  const json = JSON.parse(response.getContentText());

  if (!json.access_token) {
    throw new Error("Token request failed: " + response.getContentText());
  }

  return json.access_token;
}
