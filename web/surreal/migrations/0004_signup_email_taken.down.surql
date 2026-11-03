-- Restores the clauses from 0002, including its sign-up gate.
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
