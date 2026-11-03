-- Sign-up is a database-side switch, off by default. The SIGNUP clause of the
-- `account` access method THROWs unless `setting:signup` says otherwise, so
-- anyone who can reach SurrealDB is subject to the same gate as the web app.
-- Provisioning (`bun run db:migrate`) sets it from CONTACTKILLER_ALLOW_SIGNUP.
DEFINE TABLE setting SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD enabled ON setting TYPE bool;
DEFINE FIELD updated_at ON setting TYPE datetime VALUE time::now();
UPSERT setting:signup SET enabled = false;

-- SIGNIN additionally bounds the password length and spends the same argon2
-- work for unknown emails as for known ones, so timing does not reveal which
-- addresses have accounts.
DEFINE ACCESS OVERWRITE account ON DATABASE TYPE RECORD
  SIGNUP {
    IF (SELECT VALUE enabled FROM ONLY setting:signup) != true {
      THROW "signup_disabled";
    };
    IF type::is_string($email) = false OR type::is_string($password) = false {
      THROW "invalid_credentials";
    };
    IF string::is_email($email) = false {
      THROW "invalid_email";
    };
    IF string::len($password) < 12 OR string::len($password) > 256 {
      THROW "invalid_password_length";
    };
    RETURN (CREATE app_user SET
      email = string::lowercase(string::trim($email)),
      password_hash = crypto::argon2::generate($password));
  }
  SIGNIN {
    IF type::is_string($email) = false OR type::is_string($password) = false
       OR string::len($password) > 256 {
      THROW "invalid_credentials";
    };
    LET $address = string::lowercase(string::trim($email));
    LET $matches = (SELECT * FROM app_user WHERE email = $address);
    IF array::len($matches) = 0 {
      LET $burn = crypto::argon2::generate($password);
      RETURN NONE;
    };
    RETURN (SELECT * FROM app_user
      WHERE email = $address AND crypto::argon2::compare(password_hash, $password));
  }
  DURATION FOR TOKEN 8h, FOR SESSION 8h;
