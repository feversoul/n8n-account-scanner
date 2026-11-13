return [{ json: { ...$('Run summary').first().json, logged: Boolean($input.first().json.id) } }];
