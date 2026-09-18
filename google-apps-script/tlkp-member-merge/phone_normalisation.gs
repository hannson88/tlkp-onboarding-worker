function normalizeSG(phone) {

  if (!phone) return "";

  phone = phone.replace(/\D/g, "");

  if (phone.startsWith("65"))
    phone = phone.substring(2);

  if (phone.length === 8)
    return "+65" + phone;

  return "";

}
