-- Rollback for 0002. This restores the original unconditional SIGNUP clause;
-- do not leave a shared database in that state.
DEFINE ACCESS OVERWRITE account ON DATABASE TYPE RECORD
  SIGNUP {
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
  SIGNIN (
    SELECT * FROM app_user
    WHERE email = string::lowercase(string::trim($email))
      AND crypto::argon2::compare(password_hash, $password)
  )
  DURATION FOR TOKEN 8h, FOR SESSION 8h;
REMOVE TABLE setting;
