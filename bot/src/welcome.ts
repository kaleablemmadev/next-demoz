import { Bot } from 'grammy';

// The welcome message shown whenever someone enters the bot.
export const WELCOME_MESSAGE = `እንኳን ወደ Next Tutor Bot በሰላም መጡ!

በቦቱ ላይ ጥያቄ ወይም ችግር ዐይተው ሐሳብ ማቅረብ የሚፈልጉ ከሆነ በ @next_tutor_admin ያናግሩን። ቦቱ የጅማሮ ደረጃ ላይ እንደመሆኑ መጠን የእርስዎ ሐሳብ በጣም ይደግፈናል። ለ2 ወር ያህል የሙከራ ጊዜ እንደመሆኑ በዚህ ጊዜ ውስጥ አገልግሎት ይሰጣልም ፥ የተለያዩ ማሻሻያዎችም እንዲደረጉበት ሐሳብ እንቀበላለን።

ስለሐሳብዎና ስለጥያቄዎ እናመሰግናለን`;

export function registerWelcomeHandlers(bot: Bot) {
    bot.command('start', async (ctx, next) => {
        await ctx.reply(WELCOME_MESSAGE);
        return next();
    });
}