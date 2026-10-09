-- Rollback for 0002. The sign-up switch it introduced is removed, but rolling
-- back must never reopen registration, so SIGNUP keeps refusing everyone until
-- 0002 is applied again. SIGNIN returns to the original, unhardened clause.
DEFINE ACCESS OVERWRITE account ON DATABASE TYPE RECORD
  SIGNUP {
    THROW "signup_disabled";
  }
  SIGNIN (
    SELECT * FROM app_user
    WHERE email = string::lowercase(string::trim($email))
      AND crypto::argon2::compare(password_hash, $password)
  )
  DURATION FOR TOKEN 8h, FOR SESSION 8h;
REMOVE TABLE setting;
