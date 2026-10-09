-- Report a duplicate address explicitly. SurrealDB surfaces a unique-index
-- failure inside SIGNUP only as a generic "signup query failed", which the
-- application cannot tell apart from other failures, so SIGNUP now checks first.
-- (Two sign-ups racing for one new address can still hit the index; the
-- application treats that generic failure as a temporary error.)
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
    LET $address = string::lowercase(string::trim($email));
    IF array::len((SELECT id FROM app_user WHERE email = $address)) > 0 {
      THROW "email_taken";
    };
    RETURN (CREATE app_user SET
      email = $address,
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
